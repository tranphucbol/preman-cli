const INVALID_XML_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escapes XML metacharacters and strips control characters XML 1.0 rejects. */
export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CONTROL_CHARACTERS, "")
    .replace(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? character);
}

export interface XmlElement {
  name: string;
  attributes?: Record<string, string | number | undefined>;
  children?: XmlElement[];
  text?: string;
}

const INDENT = "  ";

function renderElement(element: XmlElement, depth: number): string {
  const indent = INDENT.repeat(depth);
  const attributes = Object.entries(element.attributes ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXml(String(value))}"`)
    .join("");
  const children = element.children ?? [];
  const text = element.text === undefined ? "" : escapeXml(element.text);

  if (children.length === 0 && text === "") return `${indent}<${element.name}${attributes}/>`;
  if (children.length === 0) return `${indent}<${element.name}${attributes}>${text}</${element.name}>`;

  const content = children.map((child) => renderElement(child, depth + 1)).join("\n");
  const textLine = text === "" ? "" : `${INDENT.repeat(depth + 1)}${text}\n`;
  return `${indent}<${element.name}${attributes}>\n${textLine}${content}\n${indent}</${element.name}>`;
}

export function renderXml(root: XmlElement): string {
  return renderElement(root, 0);
}
