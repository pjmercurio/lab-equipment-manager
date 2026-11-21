/**
 * Recurring maintenance reminders — scans the "Maintenance Schedules" sheet
 * (separate from Inventory's one-off "Needs Maintenance?" flag) and posts
 * to Slack once an item's Interval (Days) has elapsed since its Last
 * Maintained date, then re-reminds every MAINTENANCE_REMINDER_REPEAT_HOURS
 * as long as it's still not been serviced.
 *
 * Also powers the standalone "Maintenance" admin page (Code.gs's
 * renderMaintenancePage_ / MaintenancePage.html, reached via
 * <web app URL>?view=maintenance), where due items can be marked
 * complete individually — which resets Last Maintained to today, clears
 * Last Reminder Sent, and adds a checkmark reaction to that item's Slack
 * message (mirroring how the Issues page resolves reported issues).
 *
 * Expects a "Maintenance Schedules" sheet with columns:
 *   Equipment, Interval (Days), Last Maintained, Last Reminder Sent,
 *   Maintenance Procedure, Slack Ts
 *
 * Uses SLACK_BOT_TOKEN / ISSUE_REPORT_SLACK_CHANNEL_ID and
 * resolvePointOfContactMentions_ from SlackShared.gs, getCellLinkUrl_ and
 * trimmedHeaders_ from Code.gs, and addResolvedReactionToSlackMessage_
 * from Issues.gs.
 *
 * Setup: in the Apps Script editor, click the clock icon (Triggers),
 * "Add Trigger", function "checkMaintenanceSchedulesAndNotify", event
 * source "Time-driven" — daily is usually enough for a days-scale interval,
 * though you can match the 15-minute cadence used for overdue returns if
 * you want it caught sooner.
 */

const MAINTENANCE_REMINDER_REPEAT_HOURS = 20;

/**
 * Reads every row of Maintenance Schedules and returns the ones currently
 * due (interval elapsed, or never maintained at all) — regardless of
 * whether a reminder has already been sent. Used both by the notify
 * function (which additionally applies the repeat-reminder cooldown) and
 * by the Maintenance Due page (which just wants the full current list).
 */
function getDueMaintenanceItems_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Maintenance Schedules');
  if (!sheet) {
    return [];
  }

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return [];
  }
  const headers = trimmedHeaders_(data[0]);
  const equipCol = headers.indexOf('Equipment');
  const intervalCol = headers.indexOf('Interval (Days)');
  const lastMaintainedCol = headers.indexOf('Last Maintained');
  const lastReminderCol = headers.indexOf('Last Reminder Sent');
  const procedureCol = headers.indexOf('Maintenance Procedure');

  if (equipCol === -1 || intervalCol === -1 || lastMaintainedCol === -1) {
    return [];
  }

  const now = new Date();
  const items = [];

  for (let i = 1; i < data.length; i++) {
    const equipment = String(data[i][equipCol]).trim();
    const intervalDays = Number(data[i][intervalCol]);
    const lastMaintained = data[i][lastMaintainedCol];
    const neverMaintained = !(lastMaintained instanceof Date);

    if (!equipment || !intervalDays) {
      continue; // skip incomplete rows rather than erroring the whole run
    }

    let daysOverdue = null; // null = "never maintained"

    if (!neverMaintained) {
      const daysSince = (now.getTime() - lastMaintained.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < intervalDays) {
        continue; // not due yet
      }
      daysOverdue = Math.floor(daysSince - intervalDays);
    }

    const lastReminderSent = lastReminderCol !== -1 && data[i][lastReminderCol] instanceof Date
      ? data[i][lastReminderCol]
      : null;

    items.push({
      rowIndex: i + 1, // 1-based sheet row, for writing back later
      equipment: equipment,
      daysOverdue: daysOverdue,
      lastReminderSent: lastReminderSent,
      procedure: getCellLinkUrl_(sheet, i + 1, procedureCol)
    });
  }

  return items;
}

function checkMaintenanceSchedulesAndNotify() {
  if (isWeekend_()) {
    return; // skip maintenance-due reminders on weekends
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Maintenance Schedules');
  if (!sheet) {
    return;
  }

  const headers = trimmedHeaders_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  const lastReminderCol = headers.indexOf('Last Reminder Sent');
  const slackTsCol = headers.indexOf('Slack Ts');

  const now = new Date();
  const repeatMs = MAINTENANCE_REMINDER_REPEAT_HOURS * 60 * 60 * 1000;

  getDueMaintenanceItems_().forEach(function (item) {
    if (item.lastReminderSent && now.getTime() - item.lastReminderSent.getTime() < repeatMs) {
      return; // reminded recently enough — wait for the repeat interval
    }

    const slackInfo = sendMaintenanceDueReminder_(item.equipment, item.daysOverdue, item.procedure);
    if (!slackInfo) {
      return; // send failed — leave unmarked so it retries next run
    }

    if (lastReminderCol !== -1) {
      sheet.getRange(item.rowIndex, lastReminderCol + 1).setNumberFormat('M/d/yyyy HH:mm').setValue(now);
    }
    if (slackTsCol !== -1) {
      sheet.getRange(item.rowIndex, slackTsCol + 1).setNumberFormat('@').setValue(slackInfo.ts);
    }
    setInventoryNeedsMaintenance_(item.equipment, true);
  });
}

/**
 * Returns {ts} identifying the posted Slack message on success (so it can
 * be reacted to later when resolved), or null on failure — mirrors the
 * same pattern as postIssueReportToSlack_ in Issues.gs.
 */
function sendMaintenanceDueReminder_(itemName, daysOverdue, procedure) {
  const lookup = findInventoryRow_(itemName);
  const pointOfContact = lookup ? lookup.pointOfContact : '';
  const mentionText = resolvePointOfContactMentions_(pointOfContact);

  let text = ':hammer_and_wrench: *Maintenance due: ' + itemName + '* :hammer_and_wrench:\n' +
    (daysOverdue === null
      ? '_It has no recorded maintenance date on file and is due for scheduled maintenance._'
      : daysOverdue > 0
        ? '_It\'s *' + daysOverdue + '* day' + (daysOverdue === 1 ? '' : 's') + ' past its scheduled maintenance interval._'
        : '_It\'s due for scheduled maintenance._');

  if (mentionText) {
    text += '\n*Point of Contact:* ' + mentionText;
  }

  if (procedure) {
    text += /^https?:\/\//i.test(procedure)
      ? '\n*Procedure:* <' + procedure + '|View Procedure>'
      : '\n*Procedure:* ' + procedure;
  }

  const dueUrl = WEB_APP_URL + '?view=maintenance&highlight=' + encodeURIComponent(itemName);
  text += '\n*<' + dueUrl + '|View Maintenance...>*';

  const response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
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

  const result = JSON.parse(response.getContentText());
  if (!result.ok) {
    Logger.log('Slack chat.postMessage failed for maintenance reminder (' + itemName + '): ' + result.error);
    return null;
  }
  return { ts: result.ts };
}

/**
 * Called from Code.gs's resolveMaintenanceItems() for each item being
 * marked complete on the Maintenance Due page.
 */
function resolveMaintenanceReminder_(slackTs) {
  if (slackTs) {
    addResolvedReactionToSlackMessage_(ISSUE_REPORT_SLACK_CHANNEL_ID, slackTs);
  }
}
