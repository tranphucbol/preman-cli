import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();

export const databaseGenerators: GeneratorTable = {
  $randomDatabaseColumn: () => faker.database.column(),
  $randomDatabaseType: () => faker.database.type(),
  $randomDatabaseCollation: () => faker.database.collation(),
  $randomDatabaseEngine: () => faker.database.engine(),
};
