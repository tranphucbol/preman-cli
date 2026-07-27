import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();

export const addressGenerators: GeneratorTable = {
  $randomStreetName: () => faker.location.street(),
  $randomStreetAddress: () => faker.location.streetAddress(),
  $randomCity: () => faker.location.city(),
  $randomCountry: () => faker.location.country(),
  $randomCountryCode: () => faker.location.countryCode(),
  $randomZipCode: () => faker.location.zipCode(),
  $randomLatitude: () => String(faker.location.latitude()),
  $randomLongitude: () => String(faker.location.longitude()),
};
