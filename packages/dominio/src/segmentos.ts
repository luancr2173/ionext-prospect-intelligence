/**
 * Segmentos-alvo → CNAEs (subclasse, 7 dígitos) e tags do OpenStreetMap.
 * A carga da Receita confere cada CNAE contra o arquivo oficial Cnaes.zip e aborta se algum não existir,
 * então um código errado aqui não passa despercebido.
 */
export interface Segmento {
  id: string;
  nome: string;
  cnaes: string[];
  /** Filtros Overpass (chave=valor) para montar o catálogo de POIs do segmento. */
  osm: string[];
  /** Palavras que costumam compor o nome/domínio (ajudam a gerar domínios candidatos). */
  palavras: string[];
}

export const SEGMENTOS: Segmento[] = [
  { id: 'clinica_odontologica', nome: 'Clínicas odontológicas', cnaes: ['8630504'],
    osm: ['amenity=dentist', 'healthcare=dentist'], palavras: ['odonto', 'odontologia', 'clinica', 'dental'] },
  { id: 'clinica_medica', nome: 'Clínicas médicas', cnaes: ['8630501', '8630502', '8630503'],
    osm: ['amenity=clinic', 'amenity=doctors', 'healthcare=clinic', 'healthcare=doctor'], palavras: ['clinica', 'medica', 'saude'] },
  { id: 'academia', nome: 'Academias', cnaes: ['9313100'],
    osm: ['leisure=fitness_centre', 'leisure=sports_centre'], palavras: ['academia', 'fitness', 'crossfit', 'studio'] },
  { id: 'restaurante', nome: 'Restaurantes e lanchonetes', cnaes: ['5611201', '5611203'],
    osm: ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'], palavras: ['restaurante', 'bistro', 'lanchonete'] },
  { id: 'beleza', nome: 'Barbearias e salões de beleza', cnaes: ['9602501', '9602502'],
    osm: ['shop=hairdresser', 'shop=beauty'], palavras: ['barbearia', 'salao', 'studio', 'beauty', 'estetica'] },
  { id: 'oficina_mecanica', nome: 'Oficinas mecânicas', cnaes: ['4520001'],
    osm: ['shop=car_repair'], palavras: ['auto', 'oficina', 'mecanica', 'center'] },
  { id: 'construcao_civil', nome: 'Construção civil', cnaes: ['4120400'],
    osm: ['office=construction_company', 'craft=builder'], palavras: ['construtora', 'construcoes', 'engenharia'] },
  { id: 'imobiliaria', nome: 'Imobiliárias', cnaes: ['6821801', '6821802'],
    osm: ['office=estate_agent'], palavras: ['imoveis', 'imobiliaria'] },
  { id: 'contabilidade', nome: 'Escritórios de contabilidade', cnaes: ['6920601'],
    osm: ['office=accountant'], palavras: ['contabil', 'contabilidade', 'contadores'] },
];

export function segmentoPorId(id: string): Segmento | undefined {
  return SEGMENTOS.find((s) => s.id === id);
}

export function segmentoPorCnae(cnae: string): Segmento | undefined {
  return SEGMENTOS.find((s) => s.cnaes.includes(cnae));
}

export const TODOS_CNAES_ALVO = [...new Set(SEGMENTOS.flatMap((s) => s.cnaes))];
