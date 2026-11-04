/** SemVer simples (X.Y.Z, com ou sem "v"): usado para comparar a versão instalada com as publicadas. */
export const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0 se a < b, 0 se iguais, >0 se a > b. Versões inválidas ficam por último. */
export function compareVersions(a: string, b: string) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** A atualização de `from` para `to` muda o número MAIOR (pode exigir ação manual)? */
export const isMajorUpgrade = (from: string, to: string) => (parseVersion(to)?.[0] ?? 0) > (parseVersion(from)?.[0] ?? 0);
