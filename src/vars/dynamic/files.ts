import { seededFaker, type GeneratorTable } from "./faker.js";

const faker = seededFaker();
const IMAGE_CATEGORIES = {
  $randomAbstractImage: "abstract",
  $randomAnimalsImage: "animals",
  $randomBusinessImage: "business",
  $randomCatsImage: "cats",
  $randomCityImage: "city",
  $randomFashionImage: "fashion",
  $randomFoodImage: "food",
  $randomNatureImage: "nature",
  $randomNightlifeImage: "nightlife",
  $randomPeopleImage: "people",
  $randomSportsImage: "sports",
  $randomTransportImage: "transport",
} as const;

const categoryImageGenerators = Object.fromEntries(
  Object.entries(IMAGE_CATEGORIES).map(([name, category]) => [name, () => faker.image.urlLoremFlickr({ category })]),
) as GeneratorTable;

export const fileGenerators: GeneratorTable = {
  $randomFileName: () => faker.system.fileName(),
  $randomFileExt: () => faker.system.fileExt(),
  $randomFileType: () => faker.system.fileType(),
  $randomCommonFileName: () => faker.system.commonFileName(),
  $randomCommonFileExt: () => faker.system.commonFileExt(),
  $randomCommonFileType: () => faker.system.commonFileType(),
  $randomMimeType: () => faker.system.mimeType(),
  $randomFilePath: () => faker.system.filePath(),
  $randomDirectoryPath: () => faker.system.directoryPath(),
  $randomImageUrl: () => faker.image.url(),
  $randomAvatarImage: () => faker.image.avatar(),
  $randomImageDataUri: () => faker.image.dataUri(),
  ...categoryImageGenerators,
};
