// Environment-only integration credentials; never return this object over HTTP.
function readConfig() {
  return {
    intakeKey: String(process.env.POWER_AUTOMATE_INTAKE_KEY || ''),
    flowUrl: String(process.env.POWER_AUTOMATE_FLOW_URL || ''),
    flowKey: String(process.env.POWER_AUTOMATE_FLOW_KEY || ''),
    outbound: process.env.POWER_AUTOMATE_OUTBOUND_ENABLED === 'true',
    broadcastDl: String(process.env.POWER_AUTOMATE_BROADCAST_DL || ''),
  };
}
module.exports = { readConfig };
