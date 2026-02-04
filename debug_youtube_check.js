
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { searchVideos } = require('./services/youtube');

async function testYouTubeAPI() {
  console.log('Testing YouTube API with key:', process.env.YOUTUBE_API_KEY ? 'Present' : 'Missing');

  try {
    const results = await searchVideos('DatepalmBay', 1);
    console.log('Result count:', results.length);
    if (results.length > 0) {
      console.log('First video:', results[0].title);
      console.log('API Test: SUCCESS');
    } else {
      console.log('API Test: SUCCESS (No results found, but no error)');
    }
  } catch (error) {
    console.error('API Test: FAILED');
    console.error(error);
  }
}

testYouTubeAPI();
