export const isFullUrlRegex = (pattern: string): boolean =>
  /^\^?https?/.test(pattern) || pattern.includes("://");
