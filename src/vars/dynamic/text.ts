import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();

export const textGenerators: GeneratorTable = {
  $randomWord: () => faker.word.sample(),
  $randomWords: () => faker.word.words(),
  $randomPhrase: () => faker.hacker.phrase(),
  $randomNoun: () => faker.hacker.noun(),
  $randomVerb: () => faker.hacker.verb(),
  $randomIngverb: () => faker.hacker.ingverb(),
  $randomAdjective: () => faker.hacker.adjective(),
  $randomLoremWord: () => faker.lorem.word(),
  $randomLoremWords: () => faker.lorem.words(),
  $randomLoremSentence: () => faker.lorem.sentence(),
  $randomLoremSentences: () => faker.lorem.sentences(),
  $randomLoremParagraph: () => faker.lorem.paragraph(),
  $randomLoremParagraphs: () => faker.lorem.paragraphs(),
  $randomLoremText: () => faker.lorem.text(),
  $randomLoremSlug: () => faker.lorem.slug(),
  $randomLoremLines: () => faker.lorem.lines(),
};
