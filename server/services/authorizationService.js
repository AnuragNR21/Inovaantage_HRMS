const authorizationRepository = require('../repositories/authorizationRepository');

async function getAccessProfile(userId) {
  return authorizationRepository.getAccessProfile(userId);
}

async function authorize(userId, requiredPermissions) {
  const profile = await getAccessProfile(userId);
  const granted = new Set(profile.permissions);
  const alternatives = Array.isArray(requiredPermissions)
    ? [{ scope: 'ALL', permissions: requiredPermissions }]
    : requiredPermissions.alternatives;
  const matched = alternatives.find((alternative) =>
    alternative.permissions.every((permission) => granted.has(permission)));
  return {
    allowed: Boolean(matched),
    scope: matched ? matched.scope : null,
    profile,
    missing: matched ? [] : alternatives.map((alternative) => ({
      scope: alternative.scope,
      permissions: alternative.permissions.filter((permission) => !granted.has(permission))
    }))
  };
}

module.exports = { getAccessProfile, authorize };
