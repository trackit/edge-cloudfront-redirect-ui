export const buildFullUrl = (params: {
  hostname: string;
  path: string;
  protocol: string;
}): string => {
  const proto = params.protocol.endsWith("://")
    ? params.protocol
    : `${params.protocol}://`;
  return `${proto}${params.hostname}${params.path}`;
};
