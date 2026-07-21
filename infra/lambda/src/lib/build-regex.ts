export const buildRegex = (pattern: string, caseSensitive: boolean): RegExp => {
  const cleanPattern = pattern.replace(/\\\//g, "/");
  return new RegExp(cleanPattern, caseSensitive ? "" : "i");
};
