/**
 * Lab Equipment QR Checkout — Apps Script backend
 *
 * Bound to the Inventory spreadsheet. Expects three sheets:
 *   "Inventory"     — must have columns: Equipment, Checked Out?, Needs Maintenance?, Flagged?, Can Check Out?, Point of Contact, Category, QR?
 *                     Optional columns: SOP Link, Manual Link, Calendar (a Google Calendar link — shows
 *                     bookings + a "View Calendar" tile), Trained Users (comma-separated full names),
 *                     Requires Training? (Yes → shows the "Complete Training" button to anyone not yet
 *                     listed in Trained Users), Building, Room, Location (shown as "Return to:" on check-in)
 *                     ("Needs Maintenance?" is purely a visibility flag now, driven entirely by
 *                     the scheduler in Maintenance.gs — not manually set, and not gated on at
 *                     checkout — see setInventoryNeedsMaintenance_)
 *                     ("Notes" is no longer used by app logic — individual issues live in the Issues sheet below)
 *                     ("Category" + "QR?" power the bulk category checkout pages below — an item
 *                     shows up on a category page only when Category matches and QR? is Yes)
 *   "Checkout Log"  — must have columns: Equipment, User, Check Out Time, Check In Time, Expected Return, Last Overdue Reminder
 *                     Expected Return/Last Overdue Reminder live per-checkout here (not on Inventory), since
 *                     they describe a specific checkout event rather than a permanent item trait.
 *   "Users"         — must have columns: Name, Quantity Checked Out (Email optional, used to default the dropdown)
 *   "Maintenance Schedules" — must have columns: Equipment, Interval (Days), Last Maintained, Last Reminder Sent, Maintenance Procedure, Slack Ts
 *                     Interval-based recurring maintenance. "Mark Complete" on the Maintenance
 *                     Due page resets Last Maintained to today; see Maintenance.gs's
 *                     checkMaintenanceSchedulesAndNotify for the Slack reminder that fires
 *                     once Interval (Days) has elapsed.
 *   "Issues"        — must have columns: Equipment, Reported By, Reported At, Details, Slack Ts
 *                     One row per reported issue. Inventory's "Flagged?" is a derived
 *                     Yes/blank — Yes whenever an item has at least one row here, cleared
 *                     automatically once its last one is resolved (deleted) from the Issues page.
 *                     Slack Ts identifies the posted Slack message (channel is a fixed constant,
 *                     since this app only ever posts to one channel) so a checkmark reaction can
 *                     be added to it when the issue is resolved (see Issues.gs).
 *
 * Items where "Can Check Out?" is not "Yes" (but still have a QR code) route
 * to NoCheckoutPage.html instead of the normal checkout/check-in flow —
 * contact / last-used / trained-users / upcoming-bookings info, SOP / Manual /
 * Calendar tiles, Complete Training (when required), and Report an Issue.
 * Checkoutable items (CheckoutPage.html) show the same trained-users row,
 * SOP / Manual tiles and Complete Training button.
 *
 * <web app URL>?view=issues (no item param) shows every currently-flagged
 * item with a checkbox, for bulk-clearing Flagged? — see IssuesPage.html.
 *
 * <web app URL>?view=maintenance (no item param) shows every item currently
 * due per the Maintenance Schedules interval, for marking complete
 * individually — see MaintenancePage.html and Maintenance.gs.
 *
 * <web app URL>?view=diving-checkout and ?view=photography-checkout show a
 * bulk checklist of every Inventory item whose Category matches ("Diving" /
 * "Photography") and whose QR? is Yes — select a name, then check off items
 * to check out (already-checked-out items show greyed out and disabled,
 * labeled with who has them) or switch to the "Check In" tab (shown only
 * once at least one listed item is checked out) to check items back in.
 * See CategoryCheckoutPage.html (shared by every category),
 * getCategoryItems_, and processBulkCheckout.
 *
 * QR codes should encode a URL of the form:
 *   <web app URL>?item=<URL-encoded Equipment name>
 */

const INVENTORY_SHEET = 'Inventory';
const LOG_SHEET = 'Checkout Log';
const USERS_SHEET = 'Users';
const ISSUES_SHEET = 'Issues';

function doGet(e) {
  if (e.parameter.view === 'issues') {
    return renderIssuesPage_(e.parameter.highlight || '', e.parameter.reportedAt || '');
  }

  if (e.parameter.view === 'maintenance') {
    return renderMaintenancePage_(e.parameter.highlight || '');
  }

  if (e.parameter.view === 'diving-checkout') {
    return renderCategoryCheckoutPage_('Diving', 'CRE Lab Diving Equipment');
  }

  if (e.parameter.view === 'photography-checkout') {
    return renderCategoryCheckoutPage_('Photography', 'CRE Lab Photography Equipment');
  }

  var itemName = e.parameter.item;
  if (!itemName) {
    return HtmlService.createHtmlOutput('<p>Missing item. Scan a valid equipment QR code.</p>');
  }

  var lookup = findInventoryRow_(itemName);
  if (!lookup) {
    return HtmlService.createHtmlOutput('<p>Item "' + itemName + '" not found in Inventory.</p>');
  }

  var isCheckedOut = String(lookup.row[lookup.checkedOutCol]).trim().toLowerCase() === 'yes';
  var action = isCheckedOut ? 'checkin' : 'checkout';

  if (!lookup.canCheckOut) {
    var visitorEmail = Session.getActiveUser().getEmail();
    var userInfo = getUserByEmail_(visitorEmail);
    var nTemplate = HtmlService.createTemplateFromFile('NoCheckoutPage');
    nTemplate.itemName = lookup.canonicalName;
    nTemplate.sopLink = lookup.sopLink;
    nTemplate.manualLink = lookup.manualLink;
    nTemplate.calendarLink = lookup.calendarLink;
    nTemplate.bookings = getUpcomingBookings_(lookup.calendarLink);
    nTemplate.userNames = getUserNames_();
    nTemplate.matchedName = userInfo ? userInfo.name : '';
    nTemplate.pointOfContact = lookup.pointOfContact;
    nTemplate.trainedUsers = lookup.trainedUsers;
    nTemplate.canCompleteTraining = canCompleteTraining_(lookup, userInfo);
    return nTemplate.evaluate()
      .setTitle('Equipment Info')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  var template = HtmlService.createTemplateFromFile('CheckoutPage');
  template.itemName = lookup.canonicalName;
  template.action = action;
  template.buttonLabel = isCheckedOut ? 'Check In' : 'Check Out';
  template.statusText = isCheckedOut ? 'Currently checked out' : 'Currently available';
  template.returnLocationText = isCheckedOut ? buildReturnLocationText_(lookup) : '';
  template.userNames = [];
  template.matchedName = '';
  template.flaggedWarning = action === 'checkout' && lookup.flagged;
  template.sopLink = lookup.sopLink;
  template.manualLink = lookup.manualLink;
  template.openIssuesText = lookup.flagged ? getOpenIssuesForItem_(lookup.canonicalName).map(function (i) { return i.details; }).join('; ') : '';
  template.expectedReturnText = isCheckedOut ? formatDateForDisplay_(getOpenCheckoutExpectedReturn_(lookup.canonicalName)) : '';
  template.lastCheckedOutBy = '';
  template.trainedUsers = lookup.trainedUsers;
  template.canCompleteTraining = canCompleteTraining_(lookup, getUserByEmail_(Session.getActiveUser().getEmail()));

  if (action === 'checkout') {
    var visitorEmail = Session.getActiveUser().getEmail();
    var userInfo = getUserByEmail_(visitorEmail);
    template.matchedName = userInfo ? userInfo.name : '';
    template.userNames = getUserNames_();
    template.lastCheckedOutBy = getLastCheckoutUser_(lookup.canonicalName);
  }

  return template.evaluate()
    .setTitle('Lab Equipment Checkout')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called from the client via google.script.run.
 * Returns a confirmation message string, or throws on error.
 */
function processCheckout(itemName, personName, action, reportIssue, issueNotes, expectedReturn) {
  personName = (personName || '').trim();

  if (action === 'checkout') {
    if (!personName || getUserNames_().indexOf(personName) === -1) {
      throw new Error('Please select a valid name from the list.');
    }
    if (!expectedReturn) {
      throw new Error('Please select an expected return date and time.');
    }
  }

  var lookup = findInventoryRow_(itemName);
  if (!lookup) {
    throw new Error('Item not found: ' + itemName);
  }

  // Re-check current status server-side so two people scanning at once
  // can't both "check out" the same item.
  var isCheckedOut = String(lookup.row[lookup.checkedOutCol]).trim().toLowerCase() === 'yes';
  var expectedAction = isCheckedOut ? 'checkin' : 'checkout';
  if (action !== expectedAction) {
    throw new Error('This item\'s status just changed — please rescan the QR code.');
  }

  var invSheet = lookup.sheet;
  var now = new Date();
  var canonicalName = lookup.canonicalName;

  if (action === 'checkout') {
    invSheet.getRange(lookup.rowIndex + 1, lookup.checkedOutCol + 1).setValue('Yes');
    // 'YYYY-MM-DDTHH:MM' from <input type="datetime-local">
    var dateAndTime = expectedReturn.split('T');
    var dateParts = dateAndTime[0].split('-');
    var timeParts = (dateAndTime[1] || '00:00').split(':');
    var expectedReturnDate = new Date(
      Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]),
      Number(timeParts[0]), Number(timeParts[1])
    );
    appendLogRow_(canonicalName, personName, now, '', expectedReturnDate);
    updateUserCheckedOutQuantity_(personName);
    return 'Checked out "' + canonicalName + '" to ' + personName + '.';
  }

  // action === 'checkin'
  invSheet.getRange(lookup.rowIndex + 1, lookup.checkedOutCol + 1).setValue('No');
  if (reportIssue) {
    var trimmedIssueNotes = (issueNotes || '').trim();
    var reporterEmail = Session.getActiveUser().getEmail();
    var reporterInfo = getUserByEmail_(reporterEmail);
    var reporterName = reporterInfo ? reporterInfo.name : (reporterEmail || 'Unknown');
    logIssueAndNotify_(canonicalName, reporterName, trimmedIssueNotes, lookup);
  }
  var closed = fillMostRecentOpenLogEntry_(canonicalName, now);
  var closingUser = personName;
  if (closed) {
    closingUser = closed.userName || personName;
  } else {
    // No open log entry found (data drift) — log a check-in anyway for the record.
    appendLogRow_(canonicalName, personName, '', now);
  }
  if (closingUser) {
    updateUserCheckedOutQuantity_(closingUser);
  }
  return 'Checked in "' + canonicalName + '"';
}

/**
 * Called from NoCheckoutPage.html via google.script.run, for items that
 * have a QR code but Can Check Out? is not Yes.
 */
function reportIssueOnly(itemName, personName, issueNotes) {
  personName = (personName || '').trim();
  if (!personName || getUserNames_().indexOf(personName) === -1) {
    throw new Error('Please select a valid name from the list.');
  }

  var lookup = findInventoryRow_(itemName);
  if (!lookup) {
    throw new Error('Item not found: ' + itemName);
  }
  var trimmedIssueNotes = (issueNotes || '').trim();
  if (!trimmedIssueNotes) {
    throw new Error('Please describe the issue.');
  }

  logIssueAndNotify_(lookup.canonicalName, personName, trimmedIssueNotes, lookup);

  return 'Issue reported for "' + lookup.canonicalName + '".';
}

/**
 * Renders the flagged-issues admin page, reached via
 * <web app URL>?view=issues (no item param needed).
 */
function renderIssuesPage_(highlightName, highlightReportedAt) {
  var issues = getAllIssues_();

  var template = HtmlService.createTemplateFromFile('IssuesPage');
  template.issues = issues;
  template.highlightName = highlightName || '';
  template.highlightReportedAt = highlightReportedAt || '';
  return template.evaluate()
    .setTitle('CRE Lab Flagged Equipment')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called from IssuesPage.html via google.script.run. issueKeys is an array
 * of {equipment, reportedAt} pairs identifying exactly which issue rows to
 * remove (reportedAt is the formatted key string rendered on the page,
 * matching ISSUE_TIMESTAMP_FORMAT below).
 */
function resolveIssues(issueKeys) {
  if (!issueKeys || issueKeys.length === 0) {
    throw new Error('No issues selected.');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ISSUES_SHEET);
  if (!sheet) {
    throw new Error('Issues sheet not found.');
  }

  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var reportedAtCol = headers.indexOf('Reported At');
  var slackTsCol = headers.indexOf('Slack Ts');

  var rowsToDelete = [];
  var affectedEquipment = {};

  for (var i = 1; i < data.length; i++) {
    var rowEquip = String(data[i][equipCol]).trim();
    var rowKey = formatIssueTimestamp_(data[i][reportedAtCol]);

    for (var k = 0; k < issueKeys.length; k++) {
      if (issueKeys[k].equipment === rowEquip && issueKeys[k].reportedAt === rowKey) {
        rowsToDelete.push(i + 1); // sheet row number
        affectedEquipment[rowEquip] = true;
        if (slackTsCol !== -1 && data[i][slackTsCol]) {
          addResolvedReactionToSlackMessage_(ISSUE_REPORT_SLACK_CHANNEL_ID, String(data[i][slackTsCol]));
        }
        break;
      }
    }
  }

  if (rowsToDelete.length === 0) {
    throw new Error('Could not find the selected issue(s) — the sheet may have changed. Please refresh and try again.');
  }

  // Delete from the bottom up so earlier row numbers don't shift.
  rowsToDelete.sort(function (a, b) { return b - a; });
  for (var r = 0; r < rowsToDelete.length; r++) {
    sheet.deleteRow(rowsToDelete[r]);
  }

  // Clear Flagged? on any item that no longer has open issues.
  for (var equipment in affectedEquipment) {
    if (getOpenIssuesForItem_(equipment).length === 0) {
      var lookup = findInventoryRow_(equipment);
      if (lookup && lookup.flaggedCol !== -1) {
        lookup.sheet.getRange(lookup.rowIndex + 1, lookup.flaggedCol + 1).setValue('');
      }
    }
  }

  return rowsToDelete.length + ' issue' + (rowsToDelete.length === 1 ? '' : 's') + ' marked resolved.';
}

/**
 * Renders the maintenance admin page, reached via <web app URL>?view=maintenance
 * (no item param needed). The actual "which items are due" logic lives in
 * Maintenance.gs's getDueMaintenanceItems_(), shared with the notify
 * function so this list and the Slack reminders never disagree with each
 * other.
 */
function renderMaintenancePage_(highlightName) {
  var items = getDueMaintenanceItems_();

  var template = HtmlService.createTemplateFromFile('MaintenancePage');
  template.items = items;
  template.highlightName = highlightName || '';
  return template.evaluate()
    .setTitle('CRE Lab Maintenance Due')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called from MaintenancePage.html via google.script.run.
 * equipmentNames is an array of Equipment names to mark complete —
 * resets Last Maintained to today and clears Last Reminder Sent/Slack Ts,
 * after reacting to that item's original Slack message.
 */
function resolveMaintenanceItems(equipmentNames) {
  if (!equipmentNames || equipmentNames.length === 0) {
    throw new Error('No items selected.');
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Maintenance Schedules');
  if (!sheet) {
    throw new Error('Maintenance Schedules sheet not found.');
  }

  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var lastMaintainedCol = headers.indexOf('Last Maintained');
  var lastReminderCol = headers.indexOf('Last Reminder Sent');
  var slackTsCol = headers.indexOf('Slack Ts');

  var resolvedCount = 0;

  for (var i = 1; i < data.length; i++) {
    var equip = String(data[i][equipCol]).trim();
    if (equipmentNames.indexOf(equip) === -1) {
      continue;
    }

    if (slackTsCol !== -1 && data[i][slackTsCol]) {
      resolveMaintenanceReminder_(String(data[i][slackTsCol]));
    }
    if (lastMaintainedCol !== -1) {
      sheet.getRange(i + 1, lastMaintainedCol + 1).setValue(new Date());
    }
    if (lastReminderCol !== -1) {
      sheet.getRange(i + 1, lastReminderCol + 1).setValue('');
    }
    if (slackTsCol !== -1) {
      sheet.getRange(i + 1, slackTsCol + 1).setValue('');
    }
    setInventoryNeedsMaintenance_(equip, false);
    resolvedCount++;
  }

  if (resolvedCount === 0) {
    throw new Error('Could not find the selected item(s) — the sheet may have changed. Please refresh and try again.');
  }

  return resolvedCount + ' item' + (resolvedCount === 1 ? '' : 's') + ' marked complete.';
}

/**
 * Renders a bulk category checkout page (Diving, Photography, …), reached
 * via <web app URL>?view=diving-checkout / ?view=photography-checkout.
 * Every category shares CategoryCheckoutPage.html; pageTitle is used as both
 * the page heading and the browser tab title.
 */
function renderCategoryCheckoutPage_(category, pageTitle) {
  var items = getCategoryItems_(category);

  var visitorEmail = Session.getActiveUser().getEmail();
  var userInfo = getUserByEmail_(visitorEmail);

  var template = HtmlService.createTemplateFromFile('CategoryCheckoutPage');
  template.heading = pageTitle;
  template.items = items;
  template.userNames = getUserNames_();
  template.matchedName = userInfo ? userInfo.name : '';
  return template.evaluate()
    .setTitle(pageTitle)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Every Inventory item whose Category matches (case-insensitive) and whose
 * QR? is Yes, alphabetized, each with its current checkout status and (if
 * checked out) who currently has it — via getOpenCheckoutsMap_, so this
 * reads the Checkout Log exactly once no matter how many items match,
 * rather than once per item.
 */
function getCategoryItems_(category) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var checkedOutCol = headers.indexOf('Checked Out?');
  var categoryCol = headers.indexOf('Category');
  var qrCol = headers.indexOf('QR?');
  var flaggedCol = headers.indexOf('Flagged?');

  if (equipCol === -1 || checkedOutCol === -1 || categoryCol === -1 || qrCol === -1) {
    return [];
  }

  var openMap = getOpenCheckoutsMap_();
  var issuesByEquipment = getOpenIssueDetailsByEquipment_();
  var wantedCategory = category.trim().toLowerCase();
  var items = [];

  for (var i = 1; i < data.length; i++) {
    var rowCategory = String(data[i][categoryCol]).trim().toLowerCase();
    var rowQr = String(data[i][qrCol]).trim().toLowerCase();
    if (rowCategory !== wantedCategory || rowQr !== 'yes') {
      continue;
    }

    var equipment = String(data[i][equipCol]).trim();
    if (!equipment) {
      continue;
    }
    var isCheckedOut = String(data[i][checkedOutCol]).trim().toLowerCase() === 'yes';
    var isFlagged = flaggedCol !== -1 && String(data[i][flaggedCol]).trim().toLowerCase() === 'yes';

    items.push({
      equipment: equipment,
      checkedOut: isCheckedOut,
      checkedOutBy: isCheckedOut ? (openMap[equipment.toLowerCase()] || '') : '',
      flagged: isFlagged,
      issueDetails: isFlagged ? (issuesByEquipment[equipment.toLowerCase()] || '') : ''
    });
  }

  items.sort(function (a, b) { return a.equipment.localeCompare(b.equipment); });
  return items;
}

/**
 * Reads the Issues sheet once (via the existing getAllIssues_) and returns
 * { itemNameLowercase: 'detail 1; detail 2; ...' } — every open issue's
 * details for a given item joined together, the same way doGet already
 * builds openIssuesText for the single-item CheckoutPage.html warning box. Used by
 * getCategoryItems_ so the bulk checkout pages can show a warning icon
 * (with its details on tap) for flagged items, since they don't have
 * CheckoutPage.html's dedicated warning box.
 */
function getOpenIssueDetailsByEquipment_() {
  var map = {};
  getAllIssues_().forEach(function (issue) {
    var key = issue.equipment.toLowerCase();
    if (!issue.details) {
      return;
    }
    map[key] = map[key] ? map[key] + '; ' + issue.details : issue.details;
  });
  return map;
}

/**
 * Reads Checkout Log once and returns { itemNameLowercase: userName } for
 * every currently-open checkout — used by getCategoryItems_ so a whole
 * category page needs only one pass over the log, not one per item.
 * The log inserts newest rows at the top (see appendLogRow_), so the first
 * open row seen for a given item is its current (most recent) checkout.
 */
function getOpenCheckoutsMap_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var userCol = headers.indexOf('User');
  var checkinCol = headers.indexOf('Check In Time');

  var map = {};
  if (equipCol === -1 || checkinCol === -1) {
    return map;
  }

  for (var i = 1; i < data.length; i++) {
    var isOpen = data[i][checkinCol] === '' || data[i][checkinCol] === null;
    if (!isOpen) {
      continue;
    }
    var key = String(data[i][equipCol]).trim().toLowerCase();
    if (!(key in map)) {
      map[key] = userCol !== -1 ? String(data[i][userCol]).trim() : '';
    }
  }
  return map;
}

/**
 * Called from CategoryCheckoutPage.html via
 * google.script.run. equipmentNames is an array of Equipment names to check
 * out (or in) together as one batch, all under the same personName.
 * expectedReturn ('YYYY-MM-DDTHH:MM' from <input type="datetime-local">) is
 * required for a 'checkout' action and ignored for 'checkin'.
 *
 * Each item is re-verified server-side before being touched (same
 * status-just-changed protection as the single-item processCheckout), so if
 * someone else's scan raced this submission, that item is silently skipped
 * rather than failing the whole batch — the returned message says which
 * ones went through and which were skipped.
 */
function processBulkCheckout(equipmentNames, personName, action, expectedReturn) {
  personName = (personName || '').trim();
  if (!equipmentNames || equipmentNames.length === 0) {
    throw new Error('Please select at least one item.');
  }
  if (!personName || getUserNames_().indexOf(personName) === -1) {
    throw new Error('Please select a valid name from the list.');
  }
  if (action !== 'checkout' && action !== 'checkin') {
    throw new Error('Unknown action: ' + action);
  }

  var expectedReturnDate = null;
  if (action === 'checkout') {
    if (!expectedReturn) {
      throw new Error('Please select an expected return date and time.');
    }
    var dateAndTime = expectedReturn.split('T');
    var dateParts = dateAndTime[0].split('-');
    var timeParts = (dateAndTime[1] || '00:00').split(':');
    expectedReturnDate = new Date(
      Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]),
      Number(timeParts[0]), Number(timeParts[1])
    );
  }

  var now = new Date();
  var processed = [];
  var skipped = [];
  var closingUsers = {};

  for (var i = 0; i < equipmentNames.length; i++) {
    var lookup = findInventoryRow_(equipmentNames[i]);
    if (!lookup) {
      skipped.push(equipmentNames[i]);
      continue;
    }

    var isCheckedOut = String(lookup.row[lookup.checkedOutCol]).trim().toLowerCase() === 'yes';

    if (action === 'checkout') {
      if (isCheckedOut) {
        skipped.push(lookup.canonicalName);
        continue;
      }
      lookup.sheet.getRange(lookup.rowIndex + 1, lookup.checkedOutCol + 1).setValue('Yes');
      appendLogRow_(lookup.canonicalName, personName, now, '', expectedReturnDate);
      processed.push(lookup.canonicalName);
    } else {
      // action === 'checkin'
      if (!isCheckedOut) {
        skipped.push(lookup.canonicalName);
        continue;
      }
      lookup.sheet.getRange(lookup.rowIndex + 1, lookup.checkedOutCol + 1).setValue('No');
      var closed = fillMostRecentOpenLogEntry_(lookup.canonicalName, now);
      var closingUser = (closed && closed.userName) || personName;
      closingUsers[closingUser] = true;
      processed.push(lookup.canonicalName);
    }
  }

  if (action === 'checkout') {
    updateUserCheckedOutQuantity_(personName);
  } else {
    for (var user in closingUsers) {
      updateUserCheckedOutQuantity_(user);
    }
  }

  if (processed.length === 0) {
    throw new Error('None of the selected items could be ' +
      (action === 'checkout' ? 'checked out' : 'checked in') +
      ' — their status just changed. Please refresh and try again.');
  }

  var verb = action === 'checkout' ? 'Checked out' : 'Checked in';
  var message = verb + ' ' + processed.length + ' item' + (processed.length === 1 ? '' : 's') +
    (action === 'checkout' ? ' to ' + personName : '') + ': ' + processed.join(', ') + '.';
  if (skipped.length > 0) {
    message += ' (' + skipped.length + ' skipped — status just changed: ' + skipped.join(', ') + ')';
  }
  return message;
}

/**
 * Shared by processCheckout() and reportIssueOnly(): flags the item, posts
 * to Slack, and logs the issue row with that message's channel/ts so it
 * can be reacted to later when resolved.
 */
function logIssueAndNotify_(itemName, reporterName, details, lookup) {
  if (lookup.flaggedCol !== -1) {
    lookup.sheet.getRange(lookup.rowIndex + 1, lookup.flaggedCol + 1).setValue('Yes');
  }

  var now = new Date();
  var reportedAtKey = formatIssueTimestamp_(now);
  var slackInfo = postIssueReportToSlack_(itemName, reporterName, details, lookup.pointOfContact, reportedAtKey);
  appendIssueRow_(itemName, reporterName, details, now, slackInfo);
}

// ---- Issues sheet helpers ----

const ISSUE_TIMESTAMP_FORMAT = "yyyy-MM-dd'T'HH:mm:ss";

function formatIssueTimestamp_(value) {
  if (!(value instanceof Date)) {
    return String(value || '').trim();
  }
  return Utilities.formatDate(value, Session.getScriptTimeZone(), ISSUE_TIMESTAMP_FORMAT);
}

/**
 * Appends a new issue row, including the Slack message's channel/ts
 * (if it posted successfully) so it can be reacted to when resolved.
 */
function appendIssueRow_(itemName, reporterName, details, reportedAt, slackInfo) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ISSUES_SHEET);
  if (!sheet) {
    throw new Error('Issues sheet not found.');
  }
  var headers = trimmedHeaders_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  var equipCol = headers.indexOf('Equipment');
  var reportedByCol = headers.indexOf('Reported By');
  var reportedAtCol = headers.indexOf('Reported At');
  var detailsCol = headers.indexOf('Details');
  var slackTsCol = headers.indexOf('Slack Ts');

  var newRow = sheet.getLastRow() + 1;

  if (equipCol !== -1) {
    sheet.getRange(newRow, equipCol + 1).setValue(itemName);
  }
  if (reportedByCol !== -1) {
    sheet.getRange(newRow, reportedByCol + 1).setValue(reporterName);
  }
  if (reportedAtCol !== -1) {
    sheet.getRange(newRow, reportedAtCol + 1).setNumberFormat(DATETIME_FORMAT).setValue(reportedAt);
  }
  if (detailsCol !== -1) {
    sheet.getRange(newRow, detailsCol + 1).setValue(details);
  }
  if (slackTsCol !== -1 && slackInfo) {
    sheet.getRange(newRow, slackTsCol + 1).setNumberFormat('@').setValue(slackInfo.ts);
  }
}

function getAllIssues_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ISSUES_SHEET);
  if (!sheet) {
    return [];
  }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return [];
  }
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var reportedByCol = headers.indexOf('Reported By');
  var reportedAtCol = headers.indexOf('Reported At');
  var detailsCol = headers.indexOf('Details');

  if (equipCol === -1 || reportedAtCol === -1) {
    return [];
  }

  var issues = [];
  for (var i = 1; i < data.length; i++) {
    var equipment = String(data[i][equipCol]).trim();
    if (!equipment) {
      continue;
    }
    issues.push({
      equipment: equipment,
      reportedBy: reportedByCol !== -1 ? String(data[i][reportedByCol]).trim() : '',
      reportedAtKey: formatIssueTimestamp_(data[i][reportedAtCol]),
      reportedAtDisplay: data[i][reportedAtCol] instanceof Date
        ? Utilities.formatDate(data[i][reportedAtCol], Session.getScriptTimeZone(), 'M/d/yyyy h:mm a')
        : String(data[i][reportedAtCol]).trim(),
      details: detailsCol !== -1 ? String(data[i][detailsCol]).trim() : ''
    });
  }
  // Newest first.
  issues.sort(function (a, b) { return a.reportedAtKey < b.reportedAtKey ? 1 : -1; });
  return issues;
}

function getOpenIssuesForItem_(itemName) {
  return getAllIssues_().filter(function (issue) {
    return issue.equipment === itemName.trim();
  });
}

// ---- helpers ----

const DATETIME_FORMAT = 'M/d/yyyy HH:mm:ss';

function setTimestamp_(sheet, row, col, value) {
  var range = sheet.getRange(row, col);
  range.setNumberFormat(DATETIME_FORMAT);
  range.setValue(value);
}

function trimmedHeaders_(headers) {
  return headers.map(function (h) {
    return typeof h === 'string' ? h.trim() : h;
  });
}

/**
 * Sets (or clears) Inventory's "Needs Maintenance?" flag for an item —
 * driven entirely by the scheduler now (Maintenance.gs sets it to true
 * when a reminder goes out, resolveMaintenanceItems clears it when marked
 * complete), purely for visibility directly on the Inventory sheet.
 */
function setInventoryNeedsMaintenance_(itemName, needsMaintenance) {
  var lookup = findInventoryRow_(itemName);
  if (lookup && lookup.needsMaintenanceCol !== -1) {
    lookup.sheet.getRange(lookup.rowIndex + 1, lookup.needsMaintenanceCol + 1).setValue(needsMaintenance ? 'Yes' : '');
  }
}

/**
 * Pulls the Google Calendar ID out of an item's Calendar cell link — the
 * embed form (...embed?src=<id>), the add form (...?cid=<id or base64 id>),
 * or a bare calendar ID. Returns '' if none can be found.
 */
function extractCalendarId_(link) {
  link = String(link || '').trim();
  if (!link) {
    return '';
  }
  if (link.indexOf('http') !== 0) {
    return link.indexOf('@') !== -1 ? link : '';
  }
  var match = link.match(/[?&](src|cid)=([^&#]+)/);
  if (!match) {
    return '';
  }
  var value = decodeURIComponent(match[2]);
  if (value.indexOf('@') !== -1) {
    return value;
  }
  try {
    var decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(value)).getDataAsString();
    return decoded.indexOf('@') !== -1 ? decoded : '';
  } catch (err) {
    return '';
  }
}

/**
 * Upcoming events on the item's calendar, as plain text for NoCheckoutPage.
 * Returns null when the item has no usable Calendar link (page shows
 * nothing), or { ok, days: [{ label, list }], next, lastUsedBy }.
 *  - days covers today through Friday (just today + tomorrow on Fri-Sun),
 *    skipping days with no bookings; each list entry is { time, title }.
 *  - next is the first later booking within 90 days, only looked up when
 *    days is empty.
 *  - ok false means the calendar couldn't be read (e.g. the script owner
 *    lacks access to it).
 * Runs as the deployment owner (Execute as: Me), so visitors don't need
 * calendar access.
 */
function getUpcomingBookings_(calendarLink) {
  var calendarId = extractCalendarId_(calendarLink);
  if (!calendarId) {
    return null;
  }
  try {
    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) {
      // getCalendarById only finds calendars on the script owner's own list;
      // subscribing adds it (works when the owner has access to it).
      console.log('Calendar not on owner\'s list, subscribing: ' + calendarId);
      calendar = CalendarApp.subscribeToCalendar(calendarId);
    }
    if (!calendar) {
      console.log('Could not open calendar: ' + calendarId);
      return { ok: false, detail: 'Could not open calendar ' + calendarId, days: [], lastUsedBy: '' };
    }
    var tz = Session.getScriptTimeZone();
    var now = new Date();
    // forToday: drop timed events that have already ended, and tag the one
    // in progress with "(Now)". All-day events always stay.
    var formatDay = function (date, forToday) {
      return calendar.getEventsForDay(date).filter(function (ev) {
        return !(forToday && !ev.isAllDayEvent() && ev.getEndTime() <= now);
      }).map(function (ev) {
        var time = ev.isAllDayEvent()
          ? 'All day'
          : Utilities.formatDate(ev.getStartTime(), tz, 'h:mm a') + ' – ' +
            Utilities.formatDate(ev.getEndTime(), tz, 'h:mm a');
        if (forToday && !ev.isAllDayEvent() && ev.getStartTime() <= now && now < ev.getEndTime()) {
          time += ' (Now)';
        }
        return { time: time, title: ev.getTitle() };
      });
    };
    // Days to show: today through Friday of this week (Mon–Thu), or just
    // today and tomorrow on Fri/Sat/Sun. Each day with bookings becomes a
    // { label, list } section; empty days are skipped.
    var weekday = Number(Utilities.formatDate(now, tz, 'u')); // 1=Mon ... 7=Sun
    var daysAhead = weekday <= 4 ? 5 - weekday : 1;
    var days = [];
    var anyBookings = false;
    for (var i = 0; i <= daysAhead; i++) {
      var day = new Date();
      day.setDate(day.getDate() + i);
      var list = formatDay(day, i === 0);
      if (list.length > 0) {
        anyBookings = true;
        days.push({
          label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : Utilities.formatDate(day, tz, 'EEEE, MMM d'),
          list: list
        });
      }
    }

    // Nothing in that range: look ahead up to 90 days for the next booking.
    var next = null;
    if (!anyBookings) {
      var searchStart = new Date();
      searchStart.setDate(searchStart.getDate() + daysAhead + 1);
      searchStart.setHours(0, 0, 0, 0);
      var searchEnd = new Date(searchStart.getTime());
      searchEnd.setDate(searchEnd.getDate() + 90);
      var later = calendar.getEvents(searchStart, searchEnd).sort(function (a, b) {
        return a.getStartTime() - b.getStartTime();
      });
      if (later.length > 0) {
        var ev = later[0];
        var when = Utilities.formatDate(ev.getStartTime(), tz, 'EEE, MMM d');
        next = {
          time: ev.isAllDayEvent()
            ? when + ' · All day'
            : when + ' · ' + Utilities.formatDate(ev.getStartTime(), tz, 'h:mm a') + ' – ' +
              Utilities.formatDate(ev.getEndTime(), tz, 'h:mm a'),
          title: ev.getTitle()
        };
      }
    }
    // Last used by: the most recent already-ended event within the past 30
    // days, named via its creator's email matched against the Users sheet
    // (falls back to the email itself if they aren't listed there).
    var lastUsedBy = '';
    var lookBackStart = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    var past = calendar.getEvents(lookBackStart, now).filter(function (ev) {
      return ev.getEndTime() <= now;
    }).sort(function (a, b) {
      return b.getEndTime() - a.getEndTime();
    });
    if (past.length > 0) {
      var creators = past[0].getCreators();
      if (creators.length > 0) {
        var creatorInfo = getUserByEmail_(creators[0]);
        lastUsedBy = creatorInfo && creatorInfo.name ? creatorInfo.name : creators[0];
      }
    }
    return { ok: true, days: days, next: next, lastUsedBy: lastUsedBy };
  } catch (err) {
    console.log('getUpcomingBookings_ failed: ' + err.message);
    return { ok: false, detail: err.message + ' (calendar ' + calendarId + ')', days: [], lastUsedBy: '' };
  }
}

/**
 * Normalizes the Inventory "Trained Users" cell (names separated by commas,
 * semicolons, or line breaks) into a clean ", "-joined string, or '' if empty.
 */
function formatTrainedUsers_(cellValue) {
  return String(cellValue || '')
    .split(/[,;\n]+/)
    .map(function (n) { return n.trim(); })
    .filter(function (n) { return n; })
    .join(', ');
}

/** Splits the Trained Users cell text into a clean array of names. */
function parseTrainedUsers_(text) {
  return String(text || '').split(',').map(function (n) { return n.trim(); }).filter(function (n) { return n; });
}

function isTrainedUser_(trainedUsersText, name) {
  var wanted = String(name || '').trim().toLowerCase();
  return parseTrainedUsers_(trainedUsersText).some(function (n) { return n.toLowerCase() === wanted; });
}

/**
 * True when the "Complete Training!" button should show: the item requires
 * training, the visitor is a known lab member (matched by email on the
 * Users sheet), and they aren't already in the item's Trained Users.
 */
function canCompleteTraining_(lookup, visitor) {
  return !!(lookup.requiresTraining && visitor && visitor.name && !isTrainedUser_(lookup.trainedUsers, visitor.name));
}

/**
 * Called from the "Complete Training!" button. Adds the signed-in visitor's
 * full name (from the Users sheet) to the item's Inventory "Trained Users"
 * cell, and returns the new cell text.
 */
function completeTraining(itemName) {
  var visitor = getUserByEmail_(Session.getActiveUser().getEmail());
  if (!visitor || !visitor.name) {
    throw new Error('Your account isn\'t on the Users sheet.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var lookup = findInventoryRow_(itemName); // read inside the lock so concurrent adds don't clobber each other
    if (!lookup) {
      throw new Error('Item not found.');
    }
    if (!lookup.requiresTraining) {
      throw new Error('This item does not require training.');
    }
    var sheet = lookup.sheet;
    var headers = trimmedHeaders_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
    var col = headers.indexOf('Trained Users');
    if (col === -1) {
      throw new Error('Inventory sheet is missing a "Trained Users" column.');
    }
    var list = parseTrainedUsers_(lookup.trainedUsers);
    if (!isTrainedUser_(lookup.trainedUsers, visitor.name)) {
      list.push(visitor.name);
      sheet.getRange(lookup.rowIndex + 1, col + 1).setValue(list.join(', '));
      SpreadsheetApp.flush();
    }
    return list.join(', ');
  } finally {
    lock.releaseLock();
  }
}

function findInventoryRow_(itemName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var checkedOutCol = headers.indexOf('Checked Out?');
  var buildingCol = headers.indexOf('Building');
  var roomCol = headers.indexOf('Room');
  var locationCol = headers.indexOf('Location');
  var sopLinkCol = headers.indexOf('SOP Link');
  var manualLinkCol = headers.indexOf('Manual Link');
  var calendarLinkCol = headers.indexOf('Calendar');
  var notesCol = headers.indexOf('Notes');
  var flaggedCol = headers.indexOf('Flagged?');
  var needsMaintenanceCol = headers.indexOf('Needs Maintenance?');
  var canCheckOutCol = headers.indexOf('Can Check Out?');
  var pointOfContactCol = headers.indexOf('Point of Contact');
  var trainedUsersCol = headers.indexOf('Trained Users');
  var requiresTrainingCol = headers.indexOf('Requires Training?');

  if (equipCol === -1 || checkedOutCol === -1) {
    throw new Error('Inventory sheet is missing an "Equipment" or "Checked Out?" column.');
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][equipCol]).trim().toLowerCase() === itemName.trim().toLowerCase()) {
      return {
        sheet: sheet,
        rowIndex: i,
        row: data[i],
        equipCol: equipCol,
        checkedOutCol: checkedOutCol,
        notesCol: notesCol,
        flaggedCol: flaggedCol,
        needsMaintenanceCol: needsMaintenanceCol,
        canonicalName: String(data[i][equipCol]).trim(),
        building: buildingCol !== -1 ? data[i][buildingCol] : '',
        room: roomCol !== -1 ? data[i][roomCol] : '',
        location: locationCol !== -1 ? data[i][locationCol] : '',
        flagged: flaggedCol !== -1 && String(data[i][flaggedCol]).trim().toLowerCase() === 'yes',
        sopLink: getCellLinkUrl_(sheet, i + 1, sopLinkCol),
        manualLink: getCellLinkUrl_(sheet, i + 1, manualLinkCol),
        calendarLink: getCellLinkUrl_(sheet, i + 1, calendarLinkCol),
        notes: notesCol !== -1 ? String(data[i][notesCol]).trim() : '',
        canCheckOut: canCheckOutCol === -1 ? true : String(data[i][canCheckOutCol]).trim().toLowerCase() === 'yes',
        pointOfContact: pointOfContactCol !== -1 ? String(data[i][pointOfContactCol]).trim() : '',
        trainedUsers: trainedUsersCol !== -1 ? formatTrainedUsers_(data[i][trainedUsersCol]) : '',
        // "Requires Training?" = Yes. If that column doesn't exist, fall back to
        // treating any item with someone listed under Trained Users as requiring it.
        requiresTraining: requiresTrainingCol !== -1
          ? String(data[i][requiresTrainingCol]).trim().toLowerCase() === 'yes'
          : (trainedUsersCol !== -1 && formatTrainedUsers_(data[i][trainedUsersCol]) !== '')
      };
    }
  }
  return null;
}

/**
 * Returns the actual link URL for a cell — handles a Smart Chip (via the
 * Sheets Advanced Service, since normal Range methods can't see chip URLs
 * at all), a hyperlinked display text, or a bare typed URL, in that order.
 *
 * Requires the "Google Sheets API" Advanced Service to be enabled for this
 * project (Apps Script editor → Services → + → Google Sheets API).
 */
function getCellLinkUrl_(sheet, row, col) {
  if (col === -1) {
    return '';
  }

  var chipUrl = getSmartChipUrl_(sheet, row, col + 1);
  if (chipUrl) {
    return chipUrl;
  }

  var cell = sheet.getRange(row, col + 1);
  var richText = cell.getRichTextValue();
  if (richText) {
    var linkUrl = richText.getLinkUrl();
    if (linkUrl) {
      return linkUrl;
    }
    var runs = richText.getRuns();
    for (var r = 0; r < runs.length; r++) {
      var runUrl = runs[r].getLinkUrl();
      if (runUrl) {
        return runUrl;
      }
    }
  }

  var plainValue = cell.getValue();
  return plainValue ? String(plainValue).trim() : '';
}

/**
 * Pulls a Smart Chip's underlying URL via the Sheets Advanced Service's
 * chipRuns/richLinkProperties.uri field — the only way to read it, since
 * chip data is invisible to normal SpreadsheetApp Range methods.
 * Returns '' (rather than throwing) if the service isn't enabled yet, or
 * the cell has no chip, so this always degrades gracefully.
 */
function getSmartChipUrl_(sheet, row, col) {
  try {
    var ss = sheet.getParent();
    var a1 = sheet.getRange(row, col).getA1Notation();
    var range = "'" + sheet.getName() + "'!" + a1;

    var response = Sheets.Spreadsheets.get(ss.getId(), {
      ranges: [range],
      includeGridData: true,
      fields: 'sheets.data.rowData.values.chipRuns'
    });

    var rowData = response.sheets[0].data[0].rowData;
    if (!rowData || !rowData[0] || !rowData[0].values) {
      return '';
    }
    var chipRuns = rowData[0].values[0].chipRuns;
    if (!chipRuns) {
      return '';
    }
    for (var i = 0; i < chipRuns.length; i++) {
      var chip = chipRuns[i].chip;
      if (chip && chip.richLinkProperties && chip.richLinkProperties.uri) {
        return chip.richLinkProperties.uri;
      }
    }
    return '';
  } catch (e) {
    Logger.log('Smart chip lookup failed (Sheets Advanced Service may not be enabled): ' + e.message);
    return '';
  }
}

function formatDateForDisplay_(value) {
  if (!value) {
    return '';
  }
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'M/d/yyyy h:mm a');
  }
  return String(value).trim();
}

function buildReturnLocationText_(lookup) {
  var parts = [lookup.building, lookup.room, lookup.location]
    .map(function (v) { return v === null || v === undefined ? '' : String(v).trim(); })
    .filter(function (v) { return v !== ''; });
  return parts.length ? 'Return to: ' + parts.join(' ') : '';
}

function getUserByEmail_(email) {
  if (!email) {
    return null;
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    return null;
  }
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var nameCol = headers.indexOf('Name');
  var emailCol = headers.indexOf('Email');
  var adminCol = headers.indexOf('Admin');

  if (nameCol === -1 || emailCol === -1) {
    return null;
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][emailCol]).trim().toLowerCase() === email.trim().toLowerCase()) {
      return {
        name: String(data[i][nameCol]).trim(),
        isAdmin: adminCol !== -1 && String(data[i][adminCol]).trim().toLowerCase() === 'yes'
      };
    }
  }
  return null;
}

function getUserNames_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    return [];
  }
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var nameCol = headers.indexOf('Name');
  if (nameCol === -1) {
    return [];
  }
  var names = [];
  for (var i = 1; i < data.length; i++) {
    var name = data[i][nameCol];
    if (name !== null && name !== undefined && String(name).trim() !== '') {
      names.push(String(name).trim());
    }
  }
  return names;
}

function appendLogRow_(itemName, personName, checkoutTime, checkinTime, expectedReturn) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var headers = trimmedHeaders_(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  var equipCol = headers.indexOf('Equipment');
  var userCol = headers.indexOf('User');
  var checkoutCol = headers.indexOf('Check Out Time');
  var checkinCol = headers.indexOf('Check In Time');
  var expectedReturnCol = headers.indexOf('Expected Return');
  var lastReminderCol = headers.indexOf('Last Overdue Reminder');

  sheet.insertRowAfter(1);
  var newRow = 2;

  if (equipCol !== -1) {
    sheet.getRange(newRow, equipCol + 1).setValue(itemName);
  }
  if (userCol !== -1) {
    sheet.getRange(newRow, userCol + 1).setValue(personName);
  }
  if (checkoutCol !== -1 && checkoutTime) {
    sheet.getRange(newRow, checkoutCol + 1).setNumberFormat(DATETIME_FORMAT).setValue(checkoutTime);
  }
  if (checkinCol !== -1 && checkinTime) {
    sheet.getRange(newRow, checkinCol + 1).setNumberFormat(DATETIME_FORMAT).setValue(checkinTime);
  }
  if (expectedReturnCol !== -1 && expectedReturn) {
    sheet.getRange(newRow, expectedReturnCol + 1).setNumberFormat('M/d/yyyy HH:mm').setValue(expectedReturn);
  }
  if (lastReminderCol !== -1) {
    sheet.getRange(newRow, lastReminderCol + 1).setValue('');
  }

  // Reset formatting inherited from the header row (insertRowAfter copies
  // the row above it, which is bold).
  sheet.getRange(newRow, 1, 1, headers.length).setFontWeight('normal');
}

/**
 * Returns the User of the most recent Checkout Log entry for an item,
 * regardless of open/closed status — since the log inserts newest at the
 * top, this is simply the first matching row. Used to show "Last checked
 * out by" on the checkout page for an available (not currently checked
 * out) item.
 */
function getLastCheckoutUser_(itemName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var userCol = headers.indexOf('User');

  if (equipCol === -1 || userCol === -1) {
    return '';
  }

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][equipCol]).trim().toLowerCase() === itemName.trim().toLowerCase()) {
      return String(data[i][userCol]).trim();
    }
  }
  return '';
}

function getOpenCheckoutExpectedReturn_(itemName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var checkinCol = headers.indexOf('Check In Time');
  var expectedReturnCol = headers.indexOf('Expected Return');

  if (equipCol === -1 || checkinCol === -1 || expectedReturnCol === -1) {
    return null;
  }

  for (var i = 1; i < data.length; i++) {
    var matchesItem = String(data[i][equipCol]).trim() === itemName.trim();
    var isOpen = data[i][checkinCol] === '' || data[i][checkinCol] === null;
    if (matchesItem && isOpen) {
      return data[i][expectedReturnCol] instanceof Date ? data[i][expectedReturnCol] : null;
    }
  }
  return null;
}

function fillMostRecentOpenLogEntry_(itemName, checkinTime) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var equipCol = headers.indexOf('Equipment');
  var userCol = headers.indexOf('User');
  var checkinCol = headers.indexOf('Check In Time');

  if (equipCol === -1 || checkinCol === -1) {
    throw new Error('Checkout Log sheet is missing an "Equipment" or "Check In Time" column.');
  }

  for (var i = 1; i < data.length; i++) {
    var matchesItem = String(data[i][equipCol]).trim() === itemName.trim();
    var isOpen = data[i][checkinCol] === '' || data[i][checkinCol] === null;
    if (matchesItem && isOpen) {
      setTimestamp_(sheet, i + 1, checkinCol + 1, checkinTime);
      return {
        userName: userCol !== -1 ? String(data[i][userCol]).trim() : ''
      };
    }
  }
  return null;
}

function countOpenCheckoutsForUser_(personName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET);
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var userCol = headers.indexOf('User');
  var checkinCol = headers.indexOf('Check In Time');

  if (userCol === -1 || checkinCol === -1) {
    return 0;
  }

  var count = 0;
  for (var i = 1; i < data.length; i++) {
    var matchesUser = String(data[i][userCol]).trim() === personName.trim();
    var isOpen = data[i][checkinCol] === '' || data[i][checkinCol] === null;
    if (matchesUser && isOpen) {
      count++;
    }
  }
  return count;
}

function updateUserCheckedOutQuantity_(personName) {
  if (!personName) {
    return;
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(USERS_SHEET);
  if (!sheet) {
    return;
  }
  var data = sheet.getDataRange().getValues();
  var headers = trimmedHeaders_(data[0]);
  var nameCol = headers.indexOf('Name');
  var qtyCol = headers.indexOf('Quantity Checked Out');

  if (nameCol === -1 || qtyCol === -1) {
    return;
  }

  var count = countOpenCheckoutsForUser_(personName);

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][nameCol]).trim() === personName.trim()) {
      sheet.getRange(i + 1, qtyCol + 1).setValue(count > 0 ? count : '');
      return;
    }
  }
}
