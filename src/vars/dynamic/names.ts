import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();

export const nameGenerators: GeneratorTable = {
  $randomFirstName: () => faker.person.firstName(),
  $randomLastName: () => faker.person.lastName(),
  $randomFullName: () => faker.person.fullName(),
  $randomNamePrefix: () => faker.person.prefix(),
  $randomNameSuffix: () => faker.person.suffix(),
  $randomJobArea: () => faker.person.jobArea(),
  $randomJobDescriptor: () => faker.person.jobDescriptor(),
  $randomJobTitle: () => faker.person.jobTitle(),
  $randomJobType: () => faker.person.jobType(),
};
