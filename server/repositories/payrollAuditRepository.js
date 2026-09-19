async function recordEvent(conn, { runId, eventType, fromState, toState, actorUserId, details }) {
  await conn.execute(
    `INSERT INTO payroll_run_events
      (run_id, event_type, from_state, to_state, actor_user_id, details)
     VALUES (:runId, :eventType, :fromState, :toState, :actorUserId, :details)`,
    {
      runId,
      eventType,
      fromState: fromState || null,
      toState: toState || null,
      actorUserId: actorUserId || null,
      details: details ? JSON.stringify(details).slice(0, 4000) : null
    }
  );
}

module.exports = { recordEvent };
