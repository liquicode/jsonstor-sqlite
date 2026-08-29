'use strict';

const LIB_FS = require( 'fs' );
const LIB_PATH = require( 'path' );
const LIB_CRYPTO = require( 'crypto' );

const jsongin = require( '@liquicode/jsongin' );
const SQLITE = require( 'better-sqlite3' );


module.exports = {

	AdapterName: 'jsonstor-sqlite',
	AdapterDescription: 'Documents are stored in a Sqlite3 file.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		// The database file. ':memory:' is a database of its own which lives as long as this
		// storage does, which is what makes it usable here at all - see get_database().
		if ( jsongin.ShortType( Settings.Path ) !== 's' ) { throw new Error( `This adapter requires a Settings.Path string parameter.` ); }
		if ( jsongin.ShortType( Settings.Table ) !== 's' ) { throw new Error( `This adapter requires a Settings.Table string parameter.` ); }
		if ( jsongin.ShortType( Settings.IdField ) !== 's' ) { Settings.IdField = ''; }
		if ( jsongin.ShortType( Settings.ModifySchema ) !== 'b' ) { Settings.ModifySchema = false; }
		// The storage model. See jsonx/.plans/sql-adapter-architecture.md - real columns are an
		// index which pre-filters, and the payload column carries the document. With no payload
		// column the table *is* the document, and a field with no column is refused by name.
		if ( jsongin.ShortType( Settings.PayloadColumn ) !== 's' ) { Settings.PayloadColumn = ''; }
		if ( jsongin.ShortType( Settings.PayloadSync ) !== 'b' ) { Settings.PayloadSync = false; }
		if ( jsongin.ShortType( Settings.Columns ) !== 'a' ) { Settings.Columns = []; }


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );
		Storage.Catalog = {
			initialized: false,
			fields: null,
			id_field: null,
		};
		Storage.Database = null;


		//=====================================================================
		// The primary key column this adapter creates when it creates a table.
		//
		// ***A TEXT key rather than an integer one.*** Every other adapter in this family takes
		// the caller's _id as given and jsongin's _id is a uuid string. A foreign table's
		// auto-increment key is still discovered and still used; this is only what gets created.
		const DEFAULT_ID_FIELD = '_id';
		const DEFAULT_ID_TYPE = 'TEXT NOT NULL';

		// ***Not a JSON column, and SQLite offers no reason to want one.*** The payload has to
		// return the bytes which were written, because a strict equality against a whole object
		// compares field order - which is what ruled out MySQL's JSON type, whose only sin was
		// sorting the keys. TEXT is what this engine stores text in.
		const PAYLOAD_TYPE = 'TEXT DEFAULT NULL';

		// The type a declared column gets when the caller names one without a type.
		const DEFAULT_COLUMN_TYPE = 'TEXT DEFAULT NULL';

		// ***Insertion order rides on the rowid here, and no column carries it.***
		//
		// A) CRUD Tests asserts that a collection reads back in the order it was written, and a
		// SELECT with no ORDER BY promises nothing - which is the lesson readdirSync taught
		// jsonstor-folder and the VARCHAR key taught jsonstor-mysql. That adapter answers it
		// with a _seq AUTO_INCREMENT column, and SQLite cannot: AUTOINCREMENT there is only
		// legal on the INTEGER PRIMARY KEY, which is the identity column.
		//
		// It does not need one. Every rowid table has a hidden rowid assigned as MAX + 1, so a
		// row inserted later always sorts after every row already there - including after a
		// delete, because the maximum only ever moves up among the rows which remain. SELECT *
		// never returns it, so unlike _seq there is nothing to exclude from a row read, a row
		// write, or the pre-filter.
		//
		// ***A WITHOUT ROWID table has none***, and is read in the server's order, which is the
		// honest answer where jsonstor did not create the table.
		const ROWID_FIELD = 'rowid';


		//=====================================================================
		// ***What SQLite does differently, declared in one place.***
		//
		// SqlExpression defaults every one of these to the answer which is safe on every
		// engine, so this list is exactly what SQLite asks for beyond that. An option added
		// there later for another dialect arrives here as a default and can only cost this
		// adapter a rendering it never had - it can never narrow a clause. See
		// jsonx/.plans/sql-adapter-architecture.md, The Dialect Interface.
		const SQL_DIALECT = {
			// The standard spellings, and the reason they have to differ from MySQL's: a double
			// quote opens an identifier here, so a string literal is single quoted.
			IdentifierQuotes: '"',
			StringLiteralQuotes: `'`,
			// ***A backslash is an ordinary character in a SQLite string literal.*** Escaping a
			// quote with one would end the literal early; the quote is doubled instead.
			StringLiteralEscape: 'double',
			// ***SQLite has no default LIKE escape character***, so a pattern which escapes a
			// literal % has to name the character it escaped with or the clause reads it as a
			// literal backslash and drops the row.
			LikeEscapeCharacter: '\\',
			LikeEscapeClause: true,
			// The portable negation. SQLite has had IS NOT TRUE since 3.23, but the portable
			// spelling says the same thing and costs a repeated sub-expression rather than a
			// version floor.
			NegateWithIsNotTrue: false,
			// ***Left unrendered on purpose.*** SQLite can express both - % casts to integer
			// the way jsongin truncates, and & is the same operator - but a rendering is only
			// trusted here once it has been measured against a live server of its own engine,
			// and per-dialect parity is deferred. Dropping them broadens, which costs time and
			// never an answer.
			RendersModulo: false,
			RendersBitwise: false,
		};


		//=====================================================================
		// SQLite's type affinity, read from the declared type text.
		//
		// ***The declared type is a string and the rules are prefix matches***, which is why a
		// column declared MEANINGLESS still has an affinity. The order below is SQLite's own,
		// with one addition in front of it: a column declared BOOLEAN has NUMERIC affinity and
		// no way to say so afterwards, and the catalog is the only place which can remember
		// that a column was meant to hold true and false.
		function short_type_of( DeclaredType )
		{
			let type = ( jsongin.ShortType( DeclaredType ) === 's' ) ? DeclaredType.toUpperCase() : '';
			if ( type.includes( 'BOOL' ) ) { return 'b'; }
			if ( type.includes( 'INT' ) ) { return 'n'; }
			if ( type.includes( 'CHAR' ) || type.includes( 'CLOB' ) || type.includes( 'TEXT' ) ) { return 's'; }
			// A BLOB, or a column declared with no type at all. Deliberately outside the 'bns'
			// set SQL_Query pre-filters on: nothing here knows what those bytes are.
			if ( !type || type.includes( 'BLOB' ) ) { return '?'; }
			if ( type.includes( 'REAL' ) || type.includes( 'FLOA' ) || type.includes( 'DOUB' ) ) { return 'n'; }
			return 'n';
		}


		//=====================================================================
		// An identifier, quoted the way SQLite quotes one.
		//
		// ***The driver has no identifier placeholder.*** mysql2's ?? built every table and
		// column name in the sibling adapter; better-sqlite3 binds values and nothing else, so
		// every name reaches the statement through here. A double quote inside one is doubled,
		// which is the only escape SQLite offers.
		function quote_identifier( Name )
		{
			if ( jsongin.ShortType( Name ) !== 's' ) { throw new Error( `An identifier must be a string.` ); }
			return '"' + Name.split( '"' ).join( '""' ) + '"';
		}


		//=====================================================================
		// The table, as the statements name it.
		function table_reference()
		{
			return quote_identifier( Storage.Settings.Table );
		}


		//=====================================================================
		// get_database
		//
		// ***One connection for the life of this storage, rather than one per statement.***
		// The sibling adapter opens a MySQL connection for every statement and closes it after,
		// which is a reasonable thing to do with a server. It is not a reasonable thing to do
		// with ':memory:', where the database *is* the connection and closing it discards
		// everything stored. A file database would survive the reconnection and pay for it.
		function get_database()
		{
			if ( Storage.Database ) { return Storage.Database; }
			let path = Storage.Settings.Path;
			if ( path !== ':memory:' )
			{
				let folder = LIB_PATH.dirname( LIB_PATH.resolve( path ) );
				if ( !LIB_FS.existsSync( folder ) ) { LIB_FS.mkdirSync( folder, { recursive: true } ); }
			}
			Storage.Database = new SQLITE( path );
			return Storage.Database;
		}


		//=====================================================================
		// SQL_Passthrough
		//
		// The one place a statement runs. better-sqlite3 is synchronous, so this is an async
		// function with nothing to await - which keeps every caller reading the way the sibling
		// adapter's callers read.
		async function SQL_Passthrough( SqlStatement, SqlParameters = [] )
		{
			let database = get_database();
			let statement = database.prepare( SqlStatement );
			if ( statement.reader )
			{
				return { results: statement.all( SqlParameters ), info: null };
			}
			let info = statement.run( SqlParameters );
			return { results: [], info: info };
		}


		//=====================================================================
		// DDL, which takes no parameters and returns no rows.
		async function SQL_Execute( SqlStatement )
		{
			let database = get_database();
			database.exec( SqlStatement );
			return true;
		}


		//=====================================================================
		// A value on its way into a bound parameter.
		//
		// ***better-sqlite3 refuses to bind a boolean and refuses to bind undefined.*** It
		// throws rather than coercing, which is the right behavior for a driver and the wrong
		// answer for a caller who stored true. A boolean becomes 1 or 0 here, and the catalog
		// is what turns it back - the same repair the sibling adapter makes for a TINYINT,
		// arriving one layer earlier because this driver will not do it at all.
		function value_to_parameter( Value )
		{
			if ( typeof Value === 'undefined' ) { return null; }
			if ( Value === true ) { return 1; }
			if ( Value === false ) { return 0; }
			return Value;
		}


		//=====================================================================
		function has_rowid( CreateSql )
		{
			if ( jsongin.ShortType( CreateSql ) !== 's' ) { return true; }
			return !CreateSql.toUpperCase().includes( 'WITHOUT ROWID' );
		}


		//=====================================================================
		async function update_catalog()
		{
			if ( Storage.Catalog.initialized ) { return Storage.Catalog; }
			Storage.Catalog.initialized = true;
			Storage.Catalog.table_exists = false;
			Storage.Catalog.fields = {};
			Storage.Catalog.id_field = Storage.Settings.IdField;
			Storage.Catalog.order_by = null;

			// sqlite_master carries the CREATE statement verbatim, which is the only place two
			// things are written down: whether the table exists at all, and whether its key was
			// declared AUTOINCREMENT.
			let results = await SQL_Passthrough(
				`SELECT sql FROM sqlite_master WHERE ((type = 'table') AND (name = ?))`,
				[ Storage.Settings.Table ] );
			if ( !results.results.length ) { return Storage.Catalog; }
			Storage.Catalog.table_exists = true;
			let create_sql = results.results[ 0 ].sql || '';
			let declares_autoincrement = create_sql.toUpperCase().includes( 'AUTOINCREMENT' );

			let columns = await SQL_Passthrough( `PRAGMA table_info(${table_reference()})` );
			for ( let index = 0; index < columns.results.length; index++ )
			{
				let column = columns.results[ index ];
				let field = {
					name: column.name,
					type_name: column.type || '',
					short_type: short_type_of( column.type ),
					allow_null: ( column.notnull === 0 ),
					is_primary_key: ( column.pk > 0 ),
					// ***An INTEGER PRIMARY KEY is the rowid under another name***, so it fills
					// itself in whether or not AUTOINCREMENT was written. AUTOINCREMENT only
					// promises that a value is never reused.
					is_auto_increment: false,
				};
				if ( field.is_primary_key && ( field.type_name.toUpperCase().trim() === 'INTEGER' ) )
				{
					field.is_auto_increment = true;
				}
				else if ( field.is_primary_key && declares_autoincrement )
				{
					field.is_auto_increment = true;
				}
				Storage.Catalog.fields[ column.name ] = field;
			}

			// A configured IdField wins, then _id by name, and only then a foreign table's
			// auto-increment key.
			if ( !Storage.Catalog.id_field && Storage.Catalog.fields[ DEFAULT_ID_FIELD ] )
			{
				Storage.Catalog.id_field = DEFAULT_ID_FIELD;
			}
			if ( !Storage.Catalog.id_field )
			{
				for ( let key in Storage.Catalog.fields )
				{
					if ( !Storage.Catalog.fields[ key ].is_auto_increment ) { continue; }
					Storage.Catalog.id_field = key;
					break;
				}
			}

			// Insertion order. See ROWID_FIELD - this is a hidden column and never a field, so
			// it is only ever read by the ORDER BY clause.
			//
			// ***A table holding a user column actually named rowid shadows the hidden one***,
			// and SQLite resolves the name to that column. The ordering is then that column's,
			// which is what a caller who named a column rowid should expect.
			if ( has_rowid( create_sql ) ) { Storage.Catalog.order_by = ROWID_FIELD; }

			// The payload column, if this storage was configured with one and the table has it.
			Storage.Catalog.payload_field = null;
			if ( Storage.Settings.PayloadColumn )
			{
				Storage.Catalog.payload_field =
					Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] || null;
			}

			return Storage.Catalog;
		}


		//=====================================================================
		// ensure_schema
		//
		// ***jsonstor never infers a column from a document.*** Columns come from the Columns
		// declaration when this adapter creates the table, or from the table as it was found.
		// Nothing else. See jsonx/.plans/sql-adapter-architecture.md, rule R2.
		//=====================================================================
		async function ensure_schema()
		{
			if ( !Storage.Catalog.initialized ) { await update_catalog(); }
			if ( !Storage.Settings.ModifySchema ) { return; }

			let changed = false;

			if ( !Storage.Catalog.table_exists )
			{
				let id_column = declared_id_column();
				let sql = `CREATE TABLE ${table_reference()} ( ${quote_identifier( id_column.Name )} ${id_column.Type} PRIMARY KEY )`;
				await SQL_Execute( sql );
				Storage.Catalog.initialized = false;
				await update_catalog();
				changed = true;
			}

			// Every declared column which is not there yet, then the payload column. Declared
			// columns carry their SQL type verbatim: this is a SQL adapter, and a caller who
			// names a table also names its types.
			//
			// ***SQLite takes one ADD COLUMN per ALTER***, where MySQL takes a list, so this is
			// a loop rather than a join.
			let additions = [];
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				if ( column.Key ) { continue; }
				if ( Storage.Catalog.fields[ column.Name ] ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_COLUMN_TYPE;
				additions.push( { Name: column.Name, Type: type } );
			}
			if ( Storage.Settings.PayloadColumn && !Storage.Catalog.fields[ Storage.Settings.PayloadColumn ] )
			{
				additions.push( { Name: Storage.Settings.PayloadColumn, Type: PAYLOAD_TYPE } );
			}

			for ( let index = 0; index < additions.length; index++ )
			{
				let addition = additions[ index ];
				let sql = `ALTER TABLE ${table_reference()} ADD COLUMN ${quote_identifier( addition.Name )} ${addition.Type}`;
				await SQL_Execute( sql );
				changed = true;
			}

			if ( changed )
			{
				Storage.Catalog.initialized = false;
				await update_catalog();
			}
			return;
		}


		//=====================================================================
		// The primary key column this adapter creates.
		function declared_id_column()
		{
			for ( let index = 0; index < Storage.Settings.Columns.length; index++ )
			{
				let column = Storage.Settings.Columns[ index ];
				if ( jsongin.ShortType( column ) !== 'o' ) { continue; }
				if ( !column.Key ) { continue; }
				if ( jsongin.ShortType( column.Name ) !== 's' ) { continue; }
				if ( !column.Name ) { continue; }
				let type = ( jsongin.ShortType( column.Type ) === 's' ) ? column.Type : DEFAULT_ID_TYPE;
				return { Name: column.Name, Type: type };
			}
			let name = Storage.Settings.IdField || DEFAULT_ID_FIELD;
			return { Name: name, Type: DEFAULT_ID_TYPE };
		}


		//=====================================================================
		// Whether a column can hold this value without changing it.
		//
		// ***The question is the round trip, not whether the server will accept it.*** SQLite
		// accepts anything anywhere - that is what dynamic typing means - and then applies the
		// column's affinity, so a number written to a TEXT column comes back a string and there
		// is nothing in the row afterwards which says a number was meant. The affinity a column
		// declares is therefore the same promise MySQL's type is, and it is kept the same way.
		function value_fits_column( Field, Value )
		{
			let st = jsongin.ShortType( Value );
			if ( !'bns'.includes( st ) ) { return false; }
			return ( Field.short_type === st );
		}


		//=====================================================================
		function parse_payload( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return {}; }
			if ( typeof Value === 'string' )
			{
				if ( !Value ) { return {}; }
				return JSON.parse( Value );
			}
			return Value;
		}


		//=====================================================================
		function serialize_payload( Value )
		{
			return JSON.stringify( Value );
		}


		//=====================================================================
		// document_to_row
		//
		// Splits a document into the columns which pre-filter and the payload which stores it,
		// according to the three configurations in the architecture document.
		function document_to_row( Document )
		{
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );
			let row = {};

			if ( has_payload && Storage.Settings.PayloadSync )
			{
				// F3. The payload is the whole document and the columns are projections of it,
				// each holding the value when it fits and NULL when it does not. Reads never
				// take a value from a column, so a NULL here costs a pre-filter and not an
				// answer - SqlExpression broadens a projected column for exactly that reason.
				for ( let key in Storage.Catalog.fields )
				{
					if ( key === payload_name ) { continue; }
					let field = Storage.Catalog.fields[ key ];
					if ( field.is_auto_increment ) { continue; }
					if ( key === Storage.Catalog.id_field ) { continue; }
					let value = Document[ key ];
					row[ key ] = value_fits_column( field, value ) ? value : null;
				}
				row[ payload_name ] = serialize_payload( Document );
				return row;
			}

			let remainder = {};
			for ( let key in Document )
			{
				if ( key.includes( '.' ) ) { continue; }
				if ( key === payload_name )
				{
					throw new Error( `Cannot store a field named [${key}], it is this storage's payload column.` );
				}
				let value = Document[ key ];
				let field = Storage.Catalog.fields[ key ];
				if ( !field )
				{
					// F1. A field with no column is refused rather than dropped.
					if ( !has_payload )
					{
						throw new Error( `Cannot store the field [${key}], the table [${Storage.Settings.Table}] has no such column and this storage has no payload column.` );
					}
					remainder[ key ] = value;
					continue;
				}
				if ( field.is_auto_increment ) { continue; }
				if ( key === Storage.Catalog.id_field ) { continue; }
				if ( jsongin.ShortType( value ) === 'l' ) { row[ key ] = null; continue; }
				if ( !value_fits_column( field, value ) )
				{
					// F2. The column is the only home this field has, so a value it cannot hold
					// is refused rather than coerced into a lie.
					throw new Error( `Cannot store the field [${key}], its value does not fit the column's type [${field.type_name}]. Configure a PayloadColumn to store values of any type.` );
				}
				row[ key ] = value;
			}
			if ( has_payload ) { row[ payload_name ] = serialize_payload( remainder ); }
			return row;
		}


		//=====================================================================
		function row_to_document( Row )
		{
			if ( !Row ) { return null; }
			let payload_name = Storage.Settings.PayloadColumn;
			let has_payload = ( Storage.Catalog.payload_field !== null );

			// F3. Under PayloadSync the payload is the document and the columns are projections
			// of it, so a value is never taken from a column. That is the whole reason this
			// configuration keeps absent apart from null and a number apart from its string:
			// the payload is real JSON and a column is not.
			if ( has_payload && Storage.Settings.PayloadSync )
			{
				return parse_payload( Row[ payload_name ] );
			}

			// The columns are the document here, so the round trip is only as good as they are.
			// A boolean was written as 1 or 0 because the driver refuses to bind anything else,
			// and it reads back that way. The catalog knows which columns were declared to hold
			// booleans, so that much is closed here, in the one place a row becomes a document.
			let document = {};
			for ( let key in Row )
			{
				if ( has_payload && ( key === payload_name ) ) { continue; }
				let value = Row[ key ];
				let field = Storage.Catalog.fields[ key ];
				if ( field && ( field.short_type === 'b' ) && ( value !== null ) )
				{
					value = ( value ? true : false );
				}
				document[ key ] = value;
			}
			document = jsongin.Unhybridize( document );
			if ( has_payload )
			{
				let remainder = parse_payload( Row[ payload_name ] );
				for ( let key in remainder ) { document[ key ] = remainder[ key ]; }
			}
			return document;
		}


		//=====================================================================
		async function SQL_Query( Criteria, MaxDocs = 0 )
		{
			// A malformed criteria is refused, not answered - the same rule the built in
			// adapters apply. Without it a criteria of the wrong type reaches SqlExpression
			// and comes back as an empty clause, which reads as "match everything".
			let st_criteria = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( st_criteria ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }

			await update_catalog();
			if ( !Storage.Catalog.table_exists ) { return []; }

			// Convert criteria to an sql expression.
			let sql_expression_options = Object.assign( {}, SQL_DIALECT );
			sql_expression_options.AllowedFields = {};
			let payload_sync = ( Storage.Catalog.payload_field !== null ) && Storage.Settings.PayloadSync;
			for ( let key in Storage.Catalog.fields )
			{
				let field = Storage.Catalog.fields[ key ];
				if ( field.is_auto_increment ) { continue; }
				if ( key === Storage.Settings.PayloadColumn ) { continue; }
				if ( !'bns'.includes( field.short_type ) ) { continue; }
				// ***The key column is left out under PayloadSync.*** It holds String( _id ), so
				// an ordering criteria on a numeric _id would compare "10" against "5" as text
				// and lose rows. The by-id paths build their own WHERE and still use the index.
				if ( payload_sync && ( key === Storage.Catalog.id_field ) ) { continue; }
				let entry = jsongin.Clone( field );
				// F4. A projected column mirrors the payload and holds NULL where the value did
				// not fit, so every predicate on it is broadened with IS NULL.
				entry.is_projection = payload_sync;
				sql_expression_options.AllowedFields[ key ] = entry;
			}
			// ***The clause narrows the search; the residual decides the answer.***
			// Today the residual is the whole criteria, so the filtering below is
			// unchanged - but reading it from the translation rather than closing over
			// Criteria is what lets a translator earn a narrower one without this
			// adapter changing again.
			let translation = jsonstor.SqlExpression.Translate( {
				Criteria: Criteria,
				Options: sql_expression_options,
			} );
			let sql_expr = translation.Pushdown;

			// Build sql statement.
			let sql = `SELECT * FROM ${table_reference()}`;
			if ( sql_expr ) { sql += ' WHERE ' + sql_expr; }
			// ***A listing is not sorted unless it says so.*** See ROWID_FIELD.
			if ( Storage.Catalog.order_by )
			{
				sql += ' ORDER BY ' + quote_identifier( Storage.Catalog.order_by );
			}

			// Get results.
			let results = await SQL_Passthrough( sql );
			let documents = results.results;

			// Do the actual query filtering here.
			let filtered = [];
			for ( let index = 0; index < documents.length; index++ )
			{
				let document = row_to_document( documents[ index ] );
				if ( jsongin.Query( document, translation.Residual ) )
				{
					filtered.push( document );
					if ( MaxDocs && ( filtered.length === MaxDocs ) ) { break; }
				}
			}

			// Return the results.
			return filtered;
		}


		//=====================================================================
		// The value which goes in the key column.
		//
		// The payload carries the true _id with its true type; this is only what the index
		// holds. A TEXT key takes String() so that the by-id statements compare like with like.
		function id_to_key( Value )
		{
			if ( ( Value === null ) || ( typeof Value === 'undefined' ) ) { return null; }
			let field = Storage.Catalog.fields[ Storage.Catalog.id_field ];
			if ( field && 'n'.includes( field.short_type ) ) { return Value; }
			return '' + Value;
		}


		//=====================================================================
		function new_id()
		{
			// jsongin's _id is a uuid string, and the built in adapters mint one with uuid.v4()
			// when a document arrives without it. randomUUID is the same value from the runtime,
			// which keeps this adapter's dependencies to its driver.
			return LIB_CRYPTO.randomUUID();
		}


		//=====================================================================
		async function select_by_id( Key )
		{
			let sql = `SELECT * FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ?)`;
			let results = await SQL_Passthrough( sql, [ value_to_parameter( Key ) ] );
			if ( !results.results.length ) { return null; }
			return row_to_document( results.results[ 0 ] );
		}


		//=====================================================================
		async function SQL_Insert( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.table_exists ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], it does not exist. Set ModifySchema to true to have it created.` ); }
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot insert rows into table [${Storage.Settings.Table}], a primary key field was not found. ` ); }
			let id_field = Storage.Catalog.id_field;
			let id_column = Storage.Catalog.fields[ id_field ];
			let auto_increment = !!( id_column && id_column.is_auto_increment );

			// ***The caller's _id is taken as given.*** Only an auto-increment key gets to
			// choose one, and then it is the server which chooses it.
			let document = Document;
			if ( !auto_increment && ( jsongin.ShortType( document[ id_field ] ) === 'u' ) )
			{
				document = jsongin.Clone( Document );
				document[ id_field ] = new_id();
			}

			let row = document_to_row( document );
			if ( !auto_increment ) { row[ id_field ] = id_to_key( document[ id_field ] ); }

			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let names = [];
			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				names.push( quote_identifier( columns[ index ] ) );
				tokens.push( '?' );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let sql = `INSERT INTO ${table_reference()} ( ${names.join( ', ' )} ) VALUES ( ${tokens.join( ', ' )} )`;

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			let key = auto_increment ? results.info.lastInsertRowid : row[ id_field ];
			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Update( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();
			await ensure_schema();

			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot update rows in table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			let id_field = Storage.Catalog.id_field;
			if ( jsongin.ShortType( Document[ id_field ] ) === 'u' ) { throw new Error( `Cannot update this document, it is missing the id field [${id_field}].` ); }

			let row = document_to_row( Document );
			delete row[ id_field ];
			let columns = Object.keys( row );
			if ( columns.length === 0 ) { return null; }

			let tokens = [];
			let sql_parameters = [];
			for ( let index = 0; index < columns.length; index++ )
			{
				tokens.push( `${quote_identifier( columns[ index ] )} = ?` );
				sql_parameters.push( value_to_parameter( row[ columns[ index ] ] ) );
			}
			let key = id_to_key( Document[ id_field ] );
			let sql = `UPDATE ${table_reference()} SET ${tokens.join( ', ' )} WHERE (${quote_identifier( id_field )} = ?)`;
			sql_parameters.push( value_to_parameter( key ) );

			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return null; }

			return await select_by_id( key );
		}


		//=====================================================================
		async function SQL_Delete( Document )
		{
			if ( !Document ) { return null; }
			await update_catalog();

			// Get the _id field.
			if ( !Storage.Catalog.id_field ) { throw new Error( `Cannot delete rows from table [${Storage.Settings.Table}], a primary key field was not found.` ); }
			if ( jsongin.ShortType( Document[ Storage.Catalog.id_field ] ) === 'u' ) { throw new Error( `Cannot delete this document, it is missing the id field [${Storage.Catalog.id_field}].` ); }

			let sql = `DELETE FROM ${table_reference()} WHERE (${quote_identifier( Storage.Catalog.id_field )} = ?)`;
			let sql_parameters = [ value_to_parameter( id_to_key( Document[ Storage.Catalog.id_field ] ) ) ];

			// Get results.
			let results = await SQL_Passthrough( sql, sql_parameters );
			if ( !results.info || ( results.info.changes === 0 ) ) { return false; }

			return true;
		}


		//=====================================================================
		// SqlTranslation
		//
		// ***What a clause-translating adapter advertises beyond the Storage interface.***
		// This is how a shared suite, or any other caller, can ask what this adapter would
		// render and then ask the server what that rendering admits. Both halves were private
		// closures, and a suite which reconstructed them would have been measuring its own
		// copy of the dialect rather than the one this adapter actually uses.
		//
		// ***Its presence is the capability declaration.*** An adapter which does not push a
		// clause down does not define it, and a suite which needs one skips that engine
		// rather than consulting a second list somewhere which could disagree.
		//
		// Dialect answers a copy, so a caller cannot alter what this adapter renders with.
		//=====================================================================

		Storage.SqlTranslation = {
			TranslatorName: 'SqlExpression',

			// ***How this engine spells SQL, which is not the same question as how it behaves.***
			// The dialect options below say what SqlExpression renders; this says whose SQL the
			// result is, so a caller holding a statement of its own - a probe, a DDL sample -
			// can pick the spelling this server will accept. Nothing in jsonstor branches on it.
			DialectName: 'sqlite',

			// The options this adapter renders with. A copy, so a caller cannot alter them.
			Dialect: function () { return Object.assign( {}, SQL_DIALECT ); },

			// ***A logical type to this engine's spelling for it.*** A shared suite declares the
			// columns it wants in jsongin's own short types and cannot know what to call them
			// here - and a column's declared type is the promise this adapter keeps by writing
			// NULL where a value does not match it, so the suite must not guess.
			ColumnTypes: {
				b: 'BOOLEAN',
				n: 'REAL',
				s: 'TEXT',
				i: 'INTEGER',
			},

			// ***Normalized on purpose.*** SQL_Passthrough is not advertised directly because
			// the two SQL adapters do not agree about it: mysql answers { results, fields } and
			// sqlite answers { results, info }, and sqlite needs a separate DDL path because
			// better-sqlite3's prepare() is not one. A surface whose contract differs between
			// its implementations is worse than none, so callers get rows, or a promise that
			// the statement ran.
			Query: async function ( Sql, Parameters ) { return ( await SQL_Passthrough( Sql, Parameters || [] ) ).results; },
			Execute: async function ( Sql ) { return await SQL_Execute( Sql ); },
		};

		//=====================================================================
		// DropStorage
		//=====================================================================


		Storage.DropStorage = async function ( Options )
		{
			await SQL_Execute( `DROP TABLE IF EXISTS ${table_reference()}` );
			Storage.Catalog.initialized = false;
			await update_catalog();
			return true;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		Storage.FlushStorage = async function ( Options )
		{
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0 );
			return documents.length;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options = {} )
		{
			let document = await SQL_Insert( Document );
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options = {} )
		{
			let documents = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				documents.push( await SQL_Insert( Documents[ index ] ) );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function FindOne( Criteria, Projection, Options = {} )
		{
			// A read returns documents. ReturnDocuments gates what a *write* hands back, which
			// is how the built in adapters read: their FindOne, FindMany and FindMany2 never
			// consult it.
			let documents = await SQL_Query( Criteria, 1 );
			if ( !documents.length ) { return null; }
			if ( Projection )
			{
				documents[ 0 ] = jsongin.Project( documents[ 0 ], Projection );
			}
			return documents[ 0 ];
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function FindMany( Criteria, Projection, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0 );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function FindMany2( Criteria, Projection, Sort, MaxCount, Options = {} )
		{
			// A read returns documents. See the note on FindOne.
			let documents = await SQL_Query( Criteria, 0 );
			if ( Projection )
			{
				for ( let index = 0; index < documents.length; index++ )
				{
					documents[ index ] = jsongin.Project( documents[ index ], Projection );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length > MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function UpdateOne( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1 );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				document = jsongin.Update( document, Update );
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function UpdateMany( Criteria, Update, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0 );
			for ( let index = 0; index < documents.length; index++ )
			{
				documents[ index ] = jsongin.Update( documents[ index ], Update );
				documents[ index ] = await SQL_Update( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ReplaceOne( Criteria, Document, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1 );
			let document = null;
			if ( documents && documents.length )
			{
				document = documents[ 0 ];
			}
			if ( document )
			{
				if ( Document )
				{
					for ( let key in Document )
					{
						document[ key ] = Document[ key ];
					}
				}
				document = await SQL_Update( document );
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function DeleteOne( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 1 );
			let document = null;
			if ( documents && documents.length )
			{
				let result = await SQL_Delete( documents[ 0 ] );
				if ( result )
				{
					document = documents[ 0 ];
				}
			}
			if ( Options.ReturnDocuments )
			{
				return document;
			}
			else
			{
				if ( document ) { return 1; }
				else { return 0; }
			}
			return; // Unreachable code.
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function DeleteMany( Criteria, Options = {} )
		{
			let documents = await SQL_Query( Criteria, 0 );
			for ( let index = 0; index < documents.length; index++ )
			{
				await SQL_Delete( documents[ index ] );
			}
			if ( Options.ReturnDocuments )
			{
				return documents;
			}
			else
			{
				return documents.length;
			}
			return; // Unreachable code.
		};


		//=====================================================================
		return Storage;
	},

};
