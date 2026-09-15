import { normalizeText } from './periods.mjs';

// Names are matched against the actual catalog, never translated into invented
// IDs by a model. Partial matches are suggestions for the user, not selections.
export function resolveCategoryName(name, categories) {
  const expenses = categories.filter(category => !category.isIncome);
  const plain = expenses.filter(category => normalizeText(category.name) === normalizeText(name));
  const separator = name.lastIndexOf(' :: ');
  const parts = separator < 0 ? [name.trim()] : [name.slice(0, separator).trim(), name.slice(separator + 4).trim()];
  const requested = normalizeText(parts[0]);
  const exact = expenses.filter(category => normalizeText(category.name) === requested && (parts.length === 1 || parts.length === 2 && category.groupId === parts[1]));
  // A literal catalog name may itself contain the group separator. Neither
  // interpretation takes precedence: an explicit choice must not silently
  // select another category whose literal name resembles that choice.
  const matches = [...new Map([...plain, ...exact].map(category => [category.id, category])).values()];
  if (matches.length === 1) return { category: matches[0] };
  if (matches.length > 1) return { reason: 'ambiguous', requested: name, options: matches };
  const suggestions = expenses.filter(category => normalizeText(category.name).includes(requested) || requested.includes(normalizeText(category.name)));
  return { reason: 'not_found', requested: name, options: suggestions.length ? suggestions : expenses };
}
