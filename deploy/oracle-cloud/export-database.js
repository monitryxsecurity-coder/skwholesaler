const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const source = path.resolve(process.argv[2] || "data/smartcart.sqlite");
const destination = path.resolve(process.argv[3] || "sk-wholesaler-deploy.sqlite");

if (!fs.existsSync(source)) {
  throw new Error(`Source database not found: ${source}`);
}
if (source === destination) {
  throw new Error("Source and destination database paths must be different.");
}
if (fs.existsSync(destination)) {
  throw new Error(`Destination already exists; move or remove it first: ${destination}`);
}

const database = new DatabaseSync(source);
try {
  const escapedDestination = destination.replaceAll("'", "''");
  database.exec(`VACUUM INTO '${escapedDestination}'`);
  console.log(`Created consistent SQLite snapshot at ${destination}`);
} finally {
  database.close();
}
