export const toIndianTime = (date = new Date()) => {
  const d = new Date(date);
  const offsetMs = 5.5 * 60 * 60 * 1000;
  return new Date(d.getTime() + offsetMs);
};

export const formatIndianTime = (date) => {
  if (!date) return null;
  const d = new Date(date);
  if (isNaN(d.getTime())) return date;
  
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(d);
  const partMap = {};
  parts.forEach(p => { partMap[p.type] = p.value; });
  
  return `${partMap.year}-${partMap.month}-${partMap.day} ${partMap.hour}:${partMap.minute}:${partMap.second}`;
};

export const formatDatesInObject = (obj) => {
  if (obj === null || obj === undefined) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => formatDatesInObject(item));
  }
  
  if (typeof obj === 'object') {
    if (obj instanceof Date) {
      return formatIndianTime(obj);
    }
    
    // Check if it's a Sequelize model instance
    let raw = obj;
    if (typeof obj.toJSON === 'function') {
      raw = obj.toJSON();
    }
    
    const formatted = {};
    for (const key of Object.keys(raw)) {
      const val = raw[key];
      if (val instanceof Date) {
        formatted[key] = formatIndianTime(val);
      } else if (typeof val === 'string' && (key.endsWith('_at') || key === 'ts' || key === 'createdAt' || key === 'updatedAt') && !isNaN(Date.parse(val))) {
        formatted[key] = formatIndianTime(val);
      } else {
        formatted[key] = formatDatesInObject(val);
      }
    }
    return formatted;
  }
  
  return obj;
};
