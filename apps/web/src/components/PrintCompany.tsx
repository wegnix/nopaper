import { orgAddressLine, orgContactLine, orgRegistrationsLine } from '@nopaper/shared';
import { useOrgDetails } from '@/lib/queries';

/**
 * Identificação da empresa no alto das impressões (folha de pagamento, relatórios): logo, razão
 * social, CNPJ e inscrições, endereço e contato — o que estiver preenchido em Dados do espaço.
 * Só em espaços do perfil Empresa; no Pessoal a impressão segue só com o nome do espaço.
 */
export function PrintCompany() {
  const { data: o } = useOrgDetails();
  if (!o || o.kind !== 'company') return null;
  const ids = [o.document && `CNPJ ${o.document}`, orgRegistrationsLine(o)].filter(Boolean).join(' · ');
  const address = orgAddressLine(o), contact = orgContactLine(o);
  if (!o.legalName && !ids && !address && !contact && !o.logo) return null;
  return (
    <div className="pd-org">
      {o.logo && <img src={o.logo} alt="" />}
      <div>
        <b>{o.legalName?.trim() || o.name}</b>
        {ids && <span>{ids}</span>}
        {address && <span>{address}</span>}
        {contact && <span>{contact}</span>}
      </div>
    </div>
  );
}
