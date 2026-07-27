import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();
const PASSWORD_LENGTH = 15;

export const internetGenerators: GeneratorTable = {
  $randomEmail: () => faker.internet.email(),
  $randomExampleEmail: () => faker.internet.exampleEmail(),
  $randomUserName: () => faker.internet.username(),
  $randomPassword: () => faker.internet.password({ length: PASSWORD_LENGTH }),
  $randomUrl: () => faker.internet.url(),
  $randomDomainName: () => faker.internet.domainName(),
  $randomDomainSuffix: () => faker.internet.domainSuffix(),
  $randomDomainWord: () => faker.internet.domainWord(),
  $randomIP: () => faker.internet.ipv4(),
  $randomIPV6: () => faker.internet.ipv6(),
  $randomMACAddress: () => faker.internet.mac(),
  $randomUserAgent: () => faker.internet.userAgent(),
  $randomLocale: () => faker.location.language().alpha2,
  $randomProtocol: () => faker.internet.protocol(),
  $randomSemver: () => faker.system.semver(),
};
