import pg from 'pg';
import mysql from 'mysql2/promise';
import mysqlParserPackage from 'node-sql-parser/build/mysql';
import postgresParserPackage from 'node-sql-parser/build/postgresql';

const { Parser: MySqlParser } = mysqlParserPackage as unknown as typeof import('node-sql-parser');
const { Parser: PostgresParser } =
  postgresParserPackage as unknown as typeof import('node-sql-parser');

export async function runDataSourcePackagingSelfTest(): Promise<void> {
  if (typeof pg.Pool !== 'function' || typeof mysql.createPool !== 'function') {
    throw new Error('PostgreSQL or MySQL driver did not load from the packaged runtime.');
  }

  const postgresParser = new PostgresParser();
  const mysqlParser = new MySqlParser();
  const postgresSql = postgresParser.sqlify(
    postgresParser.astify('SELECT * FROM sales WHERE id = $1', { database: 'Postgresql' }),
    { database: 'Postgresql' }
  );
  const mysqlSql = mysqlParser.sqlify(
    mysqlParser.astify('SELECT * FROM sales WHERE id = ?', { database: 'MySQL' }),
    { database: 'MySQL' }
  );
  if (!postgresSql.includes('$1') || !mysqlSql.includes('?')) {
    throw new Error('Packaged SQL parser did not preserve dialect placeholders.');
  }

  const postgresPool = new pg.Pool({ max: 1 });
  const mysqlPool = mysql.createPool({
    host: '127.0.0.1',
    user: 'self-test',
    database: 'self-test',
  });
  await Promise.all([postgresPool.end(), mysqlPool.end()]);
}
