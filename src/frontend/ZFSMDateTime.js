/* One display format for every view; stored/API timestamps remain UTC. */
(function (global) {
    'use strict';
    global.zfsmFormatDateTime = function (value, settings) {
        if (value === null || value === undefined || value === '') return '—';
        const options = settings || global.zfsmDateTimeSettings || {};
        const date = new Date(typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) * 1000 : value);
        if (!Number.isFinite(date.getTime())) return '—';
        const config = {timeZone: options.timeZone || 'UTC', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',weekday:'long',hourCycle:'h23'};
        let formatter;
        try { formatter = new Intl.DateTimeFormat('en-GB', config); }
        catch (_) { formatter = new Intl.DateTimeFormat('en-GB', {...config, timeZone:'UTC'}); }
        const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type,part.value]));
        const tokens = {d:parts.day,e:String(Number(parts.day)),m:parts.month,Y:parts.year,y:parts.year.slice(-2),A:parts.weekday,a:parts.weekday.slice(0,3),H:parts.hour,M:parts.minute,S:parts.second,R:parts.hour+':'+parts.minute,T:parts.hour+':'+parts.minute+':'+parts.second,'%':'%'};
        function format(pattern, fallback) {
            if (typeof pattern !== 'string' || /%[^demYyAaHMSRT%]/.test(pattern)) pattern = fallback;
            return pattern.replace(/%([a-zA-Z%])/g, (_, token) => tokens[token] || '');
        }
        return format(options.dateFormat, '%d-%m-%Y') + ', ' + format(options.timeFormat, '%T');
    };
})(typeof window !== 'undefined' ? window : globalThis);
