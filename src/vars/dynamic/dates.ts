import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();

export const dateGenerators: GeneratorTable = {
  $randomDatePast: () => faker.date.past().toISOString(),
  $randomDateFuture: () => faker.date.future().toISOString(),
  $randomDateRecent: () => faker.date.recent().toISOString(),
  $randomMonth: () => faker.date.month(),
  $randomWeekday: () => faker.date.weekday(),
};
