/**
 * Shared Slack configuration and helpers, used by IssueReports.gs,
 * MaintenanceReminders.gs, and OverdueReturns.gs.
 *
 * Setup (this uses a Slack Bot Token, not an Incoming Webhook, since
 * reacting to a message and opening DMs both require the real API):
 * 1. Go to https://api.slack.com/apps → Create New App → From scratch.
 * 2. Under OAuth & Permissions, add Bot Token Scopes: chat:write,
 *    reactions:write, and im:write (needed for overdue-return DMs).
 * 3. Install to Workspace, then copy the Bot User OAuth Token (xoxb-...).
 * 4. Invite the bot to the channel in Slack: /invite @YourAppName
 * 5. Get the channel's ID (right-click channel name → View channel
 *    details → scroll down) and paste both below.
 * 6. Add a "Slack ID" column to the Users sheet (Name column already
 *    exists) so people can be @-mentioned (e.g. an item's Point of
 *    Contact). Find a member ID in Slack: click their name → "..." menu
 *    → "Copy member ID".
 */

const SLACK_BOT_TOKEN = 'PASTE_YOUR_BOT_TOKEN_HERE'; // xoxb-...
const ISSUE_REPORT_SLACK_CHANNEL_ID = 'PASTE_YOUR_CHANNEL_ID_HERE'; // e.g. C0123456789

/**
 * The deployed web app's real URL — from Deploy > Manage deployments in the
 * Apps Script editor (either the plain script.google.com/macros/s/... form
 * or the domain-scoped script.google.com/a/macros/ucsd.edu/s/... form both
 * work). This is hardcoded rather than read via ScriptApp.getService().getUrl()
 * because that call is only reliable inside an actual web request (doGet,
 * or google.script.run from a page the web app served) — called from a
 * time-driven trigger (as checkMaintenanceSchedulesAndNotify and
 * checkOverdueReturnsAndNotify are), it silently returns the URL of the
 * separate "HEAD" test deployment instead, which isn't shared the same way
 * and produces "Unable to open the file at this time" for anyone but the
 * script owner. If you ever push a brand-new deployment (not just a new
 * version of this one — Deploy > Manage deployments > edit > New version),
 * update this constant to match.
 */
const WEB_APP_URL = 'https://script.google.com/a/macros/ucsd.edu/s/AKfycbwEJIlbNEkHf2nAP6ngUMgdky_Y41bk0EQjcGhEW83fUAMFa2LE097U0QmCRZh37w0Vfg/exec';

/**
 * True on Saturday or Sunday, in the script's own timezone (Project
 * Settings → Time zone in the Apps Script editor). Used by the
 * scheduled-trigger functions (checkOverdueReturnsAndNotify in Issues.gs,
 * checkMaintenanceSchedulesAndNotify in Maintenance.gs) to no-op on
 * weekends — the triggers still fire on schedule, they just skip the work.
 */
function isWeekend_() {
  var day = Number(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'u')); // 1=Mon...7=Sun
  return day === 6 || day === 7;
}

/**
 * Resolves a raw Point of Contact field (e.g. "Zain Smith/Katy") into
 * Slack @-mentions where possible, splitting on common separators and
 * falling back to plain text for anything unresolved or ambiguous.
 */
function resolvePointOfContactMentions_(pointOfContact) {
  if (!pointOfContact) {
    return '';
  }

  var names = pointOfContact
    .split(/\/|,|&|\band\b/i)
    .map(function (n) { return n.trim(); })
    .filter(function (n) { return n !== ''; });

  if (names.length === 0) {
    return '';
  }

  var directory = getSlackUserDirectory_();

  return names
    .map(function (name) {
      var key = name.toLowerCase();

      // Exact full-name match first (e.g. "Zain Smith").
      if (directory.byFullName[key]) {
        return '<@' + directory.byFullName[key] + '>';
      }

      // No last name given (e.g. "Katy") — fall back to first-name-only
      // matching, but only when it's unambiguous.
      var candidates = directory.byFirstName[key];
      if (candidates && candidates.length === 1) {
        return '<@' + candidates[0] + '>';
      }

      return name; // not found, or ambiguous — leave as plain text
    })
    .join(', ');
}

/**
 * Builds a lookup of Users sheet Name → Slack ID, both by full name and
 * by first name only (the latter used when a Point of Contact field gives
 * just a first name, e.g. "Katy").
 */
function getSlackUserDirectory_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  var directory = { byFullName: {}, byFirstName: {} };
  if (!sheet) {
    return directory;
  }

  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var nameCol = headers.indexOf('Name');
  var slackIdCol = headers.indexOf('Slack ID');

  if (nameCol === -1 || slackIdCol === -1) {
    return directory;
  }

  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][nameCol]).trim();
    var slackId = String(data[i][slackIdCol]).trim();
    if (!name || !slackId) {
      continue;
    }

    directory.byFullName[name.toLowerCase()] = slackId;

    var firstName = name.split(/\s+/)[0].toLowerCase();
    if (!directory.byFirstName[firstName]) {
      directory.byFirstName[firstName] = [];
    }
    directory.byFirstName[firstName].push(slackId);
  }
  return directory;
}

/**
 * Opens (or re-opens) a DM channel with a Slack user, returning that DM's
 * channel ID for use with chat.postMessage. Used by OverdueReturns.gs.
 */
function openSlackDm_(slackUserId) {
  var response = UrlFetchApp.fetch('https://slack.com/api/conversations.open', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify({ users: slackUserId }),
    muteHttpExceptions: true
  });
  var result = JSON.parse(response.getContentText());
  if (!result.ok) {
    Logger.log('Slack conversations.open failed: ' + result.error);
    return null;
  }
  return result.channel.id;
}
