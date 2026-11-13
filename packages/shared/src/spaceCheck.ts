/**
 * Proteção contra importar no espaço errado: quem participa de vários espaços pode abrir um e enviar
 * o arquivo de outro (holerites de outra empresa, extrato de outra conta). As leituras de arquivo
 * devolvem este aviso quando o arquivo não parece ser do espaço aberto.
 */
export interface SpaceCheck {
  /** other_space = é de outro espaço de que a pessoa participa; mismatch = só dá para dizer que não é deste. */
  kind: 'other_space' | 'mismatch';
  /** O que o arquivo traz (ex.: "CNPJ 00.000.000/0001-00 · EMPRESA EXEMPLO LTDA"). */
  found: string;
  /** O que este espaço tem, quando há o que comparar (ex.: "CNPJ 11.111.111/0001-11"). */
  expected: string | null;
  /** O que bateu no outro espaço (ex.: "conta Banco Exemplo corrente", "6 de 8 funcionários"). */
  match: string | null;
  /** O outro espaço — só vem quando a pessoa é membro dele. */
  space: { id: string; name: string } | null;
}

/** CNPJ de matriz e filial têm os mesmos 8 primeiros caracteres: contam como a mesma empresa. */
export const sameCompany = (a: string, b: string) => {
  const x = a.toUpperCase().replace(/[^0-9A-Z]/g, ''), y = b.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return x.length === 14 && y.length === 14 && x.slice(0, 8) === y.slice(0, 8);
};
