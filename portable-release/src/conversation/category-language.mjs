import { normalizeText } from '../finance/periods.mjs';

// These are vocabulary hints, not financial rules. They only rank real catalog
// entries for a human-reviewed proposal; they never trigger automatic writes.
const concepts = [
  [/\b(?:lanche|lanches|lanchonete|hamburguer|sanduiche|padaria|restaurante|cafezinho|pastel)\b/, /lanche|padaria|restaurante/],
  [/\b(?:refrigerante|suco|agua)\b/, /mercado|hortifruti/],
  [/\b(?:seguro|suhai)\b/, /seguro/],
  [/\b(?:delivery|ifood|rappi|comida entregue)\b/, /delivery|refeic.*pront/],
  [/\b(?:mercado|supermercado|hortifruti|feira)\b/, /mercado|hortifruti/],
  [/\b(?:gasolina|etanol|diesel|abastecimento|combustivel)\b/, /combustivel|abastecimento/],
  [/\b(?:uber|99|onibus|metro|passagem)\b/, /aplicativ.*transporte|transporte coletivo/],
  [/\b(?:remedio|remedios|medicamento|farmacia)\b/, /farmacia|medicamento/],
  [/\b(?:psicologo|psicologa|terapia|consulta|exame|medico|dentista)\b/, /consulta|terapia|exame/],
  [/\b(?:luz|energia|eletricidade)\b/, /energia|eletric/],
  [/\b(?:internet|celular|telefone)\b/, /internet|celular|telefon/],
  [/\b(?:juros|tarifa|iof)\b/, /juros|tarifa|iof/],
  [/\b(?:cerveja|vinho|alcool|bebida|tabacaria)\b/, /bebida|tabacaria/],
  [/\b(?:roupa|cabelo|barbeiro|salao|beleza)\b/, /vestuario|beleza|cuidados pessoais/],
  [/\b(?:netflix|spotify|streaming)\b/, /streaming|entretenimento digital/],
  [/\b(?:salario|remuneracao)\b/, /salario|remuneracao/]
];
export function categoryCandidates(input, categories, groups) {
  const text = normalizeText(input), groupMap = new Map(groups.filter(g => !g.hidden).map(g => [g.id, g]));
  const vocabulary = concepts.filter(([pattern]) => pattern.test(text));
  return categories.filter(c => !c.hidden && groupMap.has(c.groupId) && !/^old[_ ]/.test(normalizeText(c.name))).map(c => {
    const name = normalizeText(c.name);
    // Consumo is a specific user-defined bucket, never a synonym for alcohol.
    const score = name === text ? 100 : name === 'consumo' ? 0
      : text.length >= 3 && name.includes(text) ? 90
      : vocabulary.some(([, pattern]) => pattern.test(name)) ? 80 : 0;
    return { ...c, groupName: groupMap.get(c.groupId).name, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export function categoryReply(input) {
  if (typeof input !== 'string' || input.length > 200) return null;
  let text = normalizeText(input).replace(/[.!]+$/, '').trim();
  if (!text || /[?;\n]/.test(text) || /\b(?:oi|ola|obrigado|obrigada|sim|nao|nunca|talvez|ou|se|quanto|quais|qual|liste|mostre|explique|lembre|guarde|esqueca|emprestimo|devolucao|reembolso|estorno)\b/.test(text)) return null;
  const match = /^(?:(?:classifique|categorize|coloque)\s+)?(?:(?:o|os|item|itens)\s+)?(#?\d{1,2}(?:\s*(?:,|e)\s*#?\d{1,2})*)\s*(?:foi|foram|e|sao|como|em|:|-)?\s+(.+)$/.exec(text);
  const references = match ? [...match[1].matchAll(/\d+/g)].map(m => Number(m[0])) : [];
  text = match ? match[2] : text.replace(/^(?:(?:isso|esse|este)(?: gasto)?\s+)?(?:foi|era|e)\s+/, '');
  if (text.split(/\s+/).length > 8 || /\d/.test(text)) return null;
  return { references, description: text.replace(/^(?:um|uma)\s+/, '') };
}
