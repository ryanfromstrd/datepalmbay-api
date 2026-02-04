
const fs = require('fs');
const path = require('path');
const dataPath = path.join(__dirname, 'mock-data.json');

try {
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  if (data.snsReviews && Array.isArray(data.snsReviews)) {
    let count = 0;
    data.snsReviews.forEach(r => {
      if (r.status === 'PENDING') {
        r.status = 'APPROVED';
        count++;
      }
    });

    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
    console.log(`Successfully approved ${count} pending reviews.`);
  } else {
    console.log('No snsReviews found in data.');
  }
} catch (error) {
  console.error('Error updating data:', error);
}
