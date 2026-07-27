import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();
const BANK_ACCOUNT_LENGTH = 8;
const CREDIT_CARD_MASK_LENGTH = 4;
const PRICE_OPTIONS = { min: 0, max: 1000, dec: 2 } as const;
const COMPANY_SUFFIXES = ["Inc", "LLC", "Group"] as const;

export const financeGenerators: GeneratorTable = {
  $randomBankAccount: () => faker.finance.accountNumber({ length: BANK_ACCOUNT_LENGTH }),
  $randomBankAccountName: () => faker.finance.accountName(),
  // Postman calls this a mask, but its documented value is the four visible digits.
  $randomCreditCardMask: () => faker.string.numeric(CREDIT_CARD_MASK_LENGTH),
  $randomBankAccountBic: () => faker.finance.bic(),
  $randomBankAccountIban: () => faker.finance.iban(),
  $randomTransactionType: () => faker.finance.transactionType(),
  $randomCurrencyCode: () => faker.finance.currencyCode(),
  $randomCurrencyName: () => faker.finance.currencyName(),
  $randomCurrencySymbol: () => faker.finance.currencySymbol(),
  $randomBitcoin: () => faker.finance.bitcoinAddress(),
  $randomPrice: () => faker.commerce.price(PRICE_OPTIONS),
  $randomProduct: () => faker.commerce.product(),
  $randomProductAdjective: () => faker.commerce.productAdjective(),
  $randomProductMaterial: () => faker.commerce.productMaterial(),
  $randomProductName: () => faker.commerce.productName(),
  $randomDepartment: () => faker.commerce.department(),
  $randomCompanyName: () => faker.company.name(),
  $randomCompanySuffix: () => faker.helpers.arrayElement(COMPANY_SUFFIXES),
  $randomBs: () => faker.company.buzzPhrase(),
  $randomBsAdjective: () => faker.company.buzzAdjective(),
  $randomBsBuzz: () => faker.company.buzzVerb(),
  $randomBsNoun: () => faker.company.buzzNoun(),
  $randomCatchPhrase: () => faker.company.catchPhrase(),
  $randomCatchPhraseAdjective: () => faker.company.catchPhraseAdjective(),
  $randomCatchPhraseDescriptor: () => faker.company.catchPhraseDescriptor(),
  $randomCatchPhraseNoun: () => faker.company.catchPhraseNoun(),
};
