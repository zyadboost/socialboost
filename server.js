function initPool() {
  let cs = process.env.DATABASE_URL;
  if (!cs) throw new Error('DATABASE_URL is not set!');
  /* Force hostname — matkhallih-ch ay haja okhra (b7al PGHOST=base) */
  cs = cs.replace(/@[^@:]+:/, '@postgres.railway.internal:');
  console.log('DB: connecting to:', cs.replace(/:[^:@]+@/, ':****@'));
  pool = new Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    max: 5,
    connectionTimeoutMillis: 15000
  });
