const { executeQuery } = require('../config/database');

async function logActivity({
  fUID = null,
  actorType = 'User',
  actorID = '',
  actorName = '',
  module = 'General',
  action = '',
  entityType = '',
  entityID = '',
  description = ''
}) {
  try {
    await executeQuery(`
      INSERT INTO ActivityLog (fUID, ActorType, ActorID, ActorName, Module, Action, EntityType, EntityID, Description, CreatedAt)
      VALUES (@fUID, @actorType, @actorID, @actorName, @module, @action, @entityType, @entityID, @description, GETDATE())
    `, {
      fUID: fUID ? parseInt(fUID) : null,
      actorType: String(actorType || 'User').substring(0, 50),
      actorID: String(actorID || '').substring(0, 50),
      actorName: String(actorName || '').substring(0, 100),
      module: String(module || 'General').substring(0, 50),
      action: String(action || '').substring(0, 50),
      entityType: String(entityType || '').substring(0, 50),
      entityID: String(entityID || '').substring(0, 50),
      description: String(description || '').substring(0, 500)
    });
  } catch (err) {
    console.error('ActivityLog insert error:', err.message);
  }
}

module.exports = { logActivity };
