import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validId } from './transaction.mjs';

const bad = () => { throw new AppError('MUTATION_CATEGORY_INVALID'); };
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const flag = value => value == null || value === false || value === 0 ? false : value === true || value === 1 ? true : bad();
const name = value => typeof value === 'string' && value.length <= 500 ? value : bad();
export function creationName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) bad();
  return value.trim();
}
export const sameCategoryName = (a, b) => a.normalize('NFKC').trim().toLocaleLowerCase('pt-BR') === b.normalize('NFKC').trim().toLocaleLowerCase('pt-BR');
export function validateCreateCategory(input) {
  if (!object(input, ['operationId','name','groupId','expectedGroup','context']) || !validId(input.operationId) || !validId(input.groupId) || creationName(input.name) !== input.name) bad();
  const group = input.expectedGroup;
  if (!object(group, ['id','name','isIncome','hidden']) || group.id !== input.groupId || !validId(group.id) || typeof group.name !== 'string' || group.name.length > 500 || typeof group.isIncome !== 'boolean' || group.hidden !== false) bad();
  if (!object(input.context, ['householdId','budgetId']) || !validId(input.context.householdId) || !validId(input.context.budgetId)) bad();
  return structuredClone(input);
}
export function categoryFingerprint(context, category) {
  if (!validId(context?.householdId) || !validId(context?.budgetId) || !object(category, ['id','name','groupId','isIncome','hidden']) || !validId(category.id) || !validId(category.groupId) || typeof category.name !== 'string' || category.name.length > 500 || typeof category.isIncome !== 'boolean' || typeof category.hidden !== 'boolean') bad();
  return createHash('sha256').update(JSON.stringify({ version:1, householdId:context.householdId, budgetId:context.budgetId, id:category.id, name:category.name, groupId:category.groupId, isIncome:category.isIncome, hidden:category.hidden })).digest('hex');
}
export async function readCategoryCatalog(api, config) {
  const categories = await api.getCategories(), groups = await api.getCategoryGroups();
  if (![categories,groups].every(rows => Array.isArray(rows) && rows.length <= 10000 && rows.every(row => validId(row?.id)) && new Set(rows.map(row => row.id)).size === rows.length)) bad();
  return {
    context:{householdId:config.householdId,budgetId:config.actual.budgetId},
    groups:groups.map(row => ({id:row.id,name:name(row.name),isIncome:flag(row.is_income),hidden:flag(row.hidden)})),
    categories:categories.map(row => { if (row.group_id != null && !validId(row.group_id)) bad(); return {id:row.id,name:name(row.name),groupId:row.group_id ?? null,isIncome:flag(row.is_income),hidden:flag(row.hidden)}; })
  };
}
export function checkCreationGroup(catalog, args) {
  const group = catalog.groups.find(row => row.id === args.groupId);
  if (!group || ['id','name','isIncome','hidden'].some(key => group[key] !== args.expectedGroup[key])) bad();
}
export function checkCreationAvailable(catalog, args) {
  checkCreationGroup(catalog, args);
  if (catalog.categories.some(row => row.groupId === args.groupId && sameCategoryName(row.name, args.name))) throw new AppError('MUTATION_CONFLICT');
}
