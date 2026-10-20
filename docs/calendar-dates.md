# Calendar date parsing rules

Detection and input share the bounded grammar in `packages/core/src/calendar/event-dates.ts`. No LLM is involved. Relative dates and dates without a year are resolved against the message date and the IANA time zone chosen in the confirmation window.

- A bare English weekday means the next occurrence of that weekday. If it names today's weekday, the parser asks for confirmation.
- `this` expressions such as `this Friday` mean today or the next occurrence of that weekday. They never go back in time.
- English `next` with a different weekday asks for confirmation, so "the nearest one" and "the one in the following week" are not confused. `next` with today's weekday means seven days later.
- Chinese `下周` / `下星期` ("next week") use the next calendar week starting on Monday. `本周` / `这周` ("this week") use today or the next occurrence of that weekday. `周` / `星期` ("weekday") behave like a bare English weekday. <!-- cjk-ok -->
- A month and day without a year that falls 1 to 14 days before the local date asks for an explicit year. Earlier dates move to the next year. An explicit year is kept as written. A range across months keeps the end month. A range across years moves the end date forward one year. All-day end dates are exclusive.
- Numeric dates such as `03/04`, where both month and day are 12 or less, ask for confirmation. `13/4` and `4/13` resolve uniquely to April 13. Dots in amounts and versions are not date separators.
- A single time without a date asks for confirmation. A 12-hour time in natural language without am/pm or a Chinese time-of-day word asks for confirmation. Times of 13:00 and later, and explicit ISO date-times, use the 24-hour clock.
- `noon tomorrow` / `tomorrow at noon` / `at noon on Friday` / `on Friday at 3pm` / `明天中午` ("noon tomorrow") / `周五中午` ("Friday noon") each form one candidate. A Chinese time-of-day word carries over to an end time in the same range that has none. <!-- cjk-ok -->
- If a range's end time is earlier than its start time and both hours are 12 or less, the parser adds 12 hours to the end time. `11am to 1` / `上午11点到1点` ("11am to 1") is 11:00 to 13:00. When such a range has no date, it uses the reference date. Other reversed ranges, ranges with equal endpoints and ranges without a date ask for confirmation. <!-- cjk-ok -->
- The grammar supports `日` / `号` (day-of-month suffixes), `明年` ("next year") with a month and day, and `凌晨` ("early morning"). Outside the supported grammar the parser does not guess dates. <!-- cjk-ok -->
- When daylight saving time makes a wall-clock time missing or repeated, the parser asks for confirmation and suggests entering a UTC offset. A valid explicit ISO offset determines the exact instant.

`packages/core/src/calendar/event-dates.test.ts` covers every weekday combination, ranges across months and years, the amount and version exclusions, time-of-day inheritance and DST behavior. The UI summary uses Lingui ICU plurals and Intl date and list formats. Japanese uses only the `other` branch.
