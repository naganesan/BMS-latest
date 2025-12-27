// Import the filesystem module
const fs = require('fs');

// Read the JSON file (synchronously)
const data = fs.readFileSync('locations.json', 'utf8');

// Parse the JSON string into a JavaScript array
const locations = JSON.parse(data);

// Count the number of items
console.log("Number of locations:", locations.length);
