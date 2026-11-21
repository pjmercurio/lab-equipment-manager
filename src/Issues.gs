/**
 * Issue-related Slack notifications: reported issues (with a resolved
 * checkmark reaction) and overdue-return reminders — grouped together
 * since both are about problems with equipment currently in use, as
 * opposed to Maintenance.gs's scheduled maintenance-due reminders.
 *
 * Uses SLACK_BOT_TOKEN / ISSUE_REPORT_SLACK_CHANNEL_ID and the shared
 * helpers (resolvePointOfContactMentions_, getSlackUserDirectory_,
 * openSlackDm_) from SlackShared.gs.
 */

/* ---- Reported issues ---- */

/**
 * Called from Code.gs's processCheckout() and reportIssueOnly() when an
 * issue is reported. pointOfContact is the raw Inventory field text — it
 * may contain multiple names (e.g. "Zain Smith/Katy"), so this splits on
 * common separators and resolves what it can. reportedAtKey is the issue's
 * formatted timestamp (generated in Code.gs before this is called), used
 * to link back to this exact issue rather than just the item.
 *
 * Returns {channel, ts} identifying the posted message (or null on
 * failure), which Code.gs stores alongside the Issues row so it can be
 * reacted to later when resolved.
 */
function postIssueReportToSlack_(itemName, reporterName, notes, pointOfContact, reportedAtKey) {
  var text = ':warning: *Issue reported: ' + itemName + '* :warning:\n' +
    '*Reported by:* ' + (reporterName || 'Unknown') + '\n' +
    '*Details:* ' + (notes || '(no details provided)');

  var mentionText = resolvePointOfContactMentions_(pointOfContact);
  if (mentionText) {
    text += '\n*Point of Contact:* ' + mentionText;
  }

  var issuesUrl = WEB_APP_URL + '?view=issues&highlight=' + encodeURIComponent(itemName);
  if (reportedAtKey) {
    issuesUrl += '&reportedAt=' + encodeURIComponent(reportedAtKey);
  }
  text += '\n*<' + issuesUrl + '|View Issue...>*';

  var response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify({
      channel: ISSUE_REPORT_SLACK_CHANNEL_ID,
      text: text,
      unfurl_links: false,
      unfurl_media: false
    }),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (!result.ok) {
    Logger.log('Slack postMessage failed: ' + result.error);
    return null;
  }
  return { channel: result.channel, ts: result.ts };
}

/**
 * Called from Code.gs's resolveIssues() for each issue being resolved,
 * using the channel/ts stored on that Issues row when it was first posted.
 */
function addResolvedReactionToSlackMessage_(channel, ts) {
  if (!channel || !ts) {
    return;
  }
  var response = UrlFetchApp.fetch('https://slack.com/api/reactions.add', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify({ channel: channel, timestamp: ts, name: 'white_check_mark' }),
    muteHttpExceptions: true
  });
  var result = JSON.parse(response.getContentText());
  if (!result.ok && result.error !== 'already_reacted') {
    Logger.log('Slack reactions.add failed: ' + result.error);
  }
}

/* ---- Overdue-return reminders ---- */

/**
 * DMs whoever currently has an item checked out once it's
 * OVERDUE_RETURN_GRACE_MINUTES past its Expected Return, then re-reminds
 * every OVERDUE_REMINDER_REPEAT_HOURS as long as it's still not checked
 * in, tracked via Checkout Log's "Last Overdue Reminder" timestamp
 * (cleared automatically on every fresh checkout, since it's a new row).
 *
 * Setup:
 * 1. Add "im:write" to this app's Bot Token Scopes (needed to open a DM),
 *    then reinstall the app to the workspace to pick up the new scope.
 * 2. In the Apps Script editor: click the clock icon (Triggers), "Add
 *    Trigger", function "checkOverdueReturnsAndNotify", event source
 *    "Time-driven", type "Minutes timer", every 15 minutes (or hourly, if
 *    you don't need it caught right at the 1-hour mark).
 * 3. Add "Expected Return" and "Last Overdue Reminder" columns to the
 *    Checkout Log sheet (they live per-checkout there, not on Inventory).
 */

const OVERDUE_RETURN_GRACE_MINUTES = 60;
const OVERDUE_REMINDER_REPEAT_HOURS = 24;

/**
 * Scans Checkout Log directly (not Inventory) for open checkouts — rows
 * with no Check In Time yet — that are past their Expected Return. This
 * early "isOpen" skip means closed (already-checked-in) rows never get any
 * further processing at all, so the scan stays cheap even as the log grows.
 */
function checkOverdueReturnsAndNotify() {
  if (isWeekend_()) {
    return; // skip overdue-return reminders on weekends
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var userCol = headers.indexOf('User');
  var checkinCol = headers.indexOf('Check In Time');
  var expectedReturnCol = headers.indexOf('Expected Return');
  var lastReminderCol = headers.indexOf('Last Overdue Reminder');

  if (equipCol === -1 || checkinCol === -1 || expectedReturnCol === -1) {
    return;
  }

  var now = new Date();
  var graceMs = OVERDUE_RETURN_GRACE_MINUTES * 60 * 1000;
  var repeatMs = OVERDUE_REMINDER_REPEAT_HOURS * 60 * 60 * 1000;

  for (var i = 1; i < data.length; i++) {
    var isOpen = data[i][checkinCol] === '' || data[i][checkinCol] === null;
    if (!isOpen) {
      continue; // already checked in — skip immediately, no further work
    }

    var expectedReturn = data[i][expectedReturnCol];
    if (!(expectedReturn instanceof Date)) {
      continue;
    }

    if (now.getTime() - expectedReturn.getTime() < graceMs) {
      continue; // not yet past the grace period
    }

    var lastReminder = lastReminderCol !== -1 ? data[i][lastReminderCol] : null;
    if (lastReminder instanceof Date && now.getTime() - lastReminder.getTime() < repeatMs) {
      continue; // reminded recently enough — wait for the repeat interval
    }

    var itemName = String(data[i][equipCol]).trim();
    var borrowerName = userCol !== -1 ? String(data[i][userCol]).trim() : '';
    var sent = sendOverdueReturnReminder_(itemName, borrowerName, expectedReturn);

    if (sent && lastReminderCol !== -1) {
      sheet.getRange(i + 1, lastReminderCol + 1).setNumberFormat('M/d/yyyy HH:mm').setValue(now);
    }
  }
}

/**
 * Returns true if the Slack message actually posted successfully, false
 * otherwise — callers should NOT mark the reminder as sent on failure, so
 * it retries on the next trigger run instead of getting silently stuck.
 */
function sendOverdueReturnReminder_(itemName, borrowerName, expectedReturn) {
  var directory = getSlackUserDirectory_();
  var slackId = borrowerName ? directory.byFullName[borrowerName.toLowerCase()] : null;

  var dueText = Utilities.formatDate(expectedReturn, Session.getScriptTimeZone(), 'M/d/yyyy h:mm a');
  var message = ':alarm_clock: Your checkout of *' + itemName + '* was expected back ' + dueText +
    ' and hasn\'t been checked in yet. Please return it when you can!';

  var targetChannel = ISSUE_REPORT_SLACK_CHANNEL_ID;

  if (slackId) {
    var dmChannel = openSlackDm_(slackId);
    if (dmChannel) {
      targetChannel = dmChannel;
    } else {
      message = '<@' + slackId + '> ' + message; // DM open failed — fall back to a tagged channel post
    }
  } else {
    message = (borrowerName || 'Unknown') + ' — ' + message; // no Slack ID on file — plain-text channel post
  }

  var response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + SLACK_BOT_TOKEN },
    payload: JSON.stringify({ channel: targetChannel, text: message }),
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (!result.ok) {
    Logger.log('Slack chat.postMessage failed for overdue reminder (' + itemName + '): ' + result.error);
    return false;
  }
  return true;
}
