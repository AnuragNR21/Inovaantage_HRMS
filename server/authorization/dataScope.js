function applyEmployeeScope(req, conditions, binds, employeeColumn) {
  if (!req.dataScope || req.dataScope.type === 'ALL') return;
  if (req.dataScope.type !== 'SELF' || !req.dataScope.employeeId) {
    throw new Error('A valid employee data scope is required.');
  }
  conditions.push(`${employeeColumn} = :authorizedEmployeeId`);
  binds.authorizedEmployeeId = req.dataScope.employeeId;
}

module.exports = { applyEmployeeScope };
