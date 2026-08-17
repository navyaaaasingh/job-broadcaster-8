require('dotenv').config();
const express = require('express');
const path = require('path');
const broadcastRoutes = require('./routes/broadcast');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use('/api', broadcastRoutes);
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Job Broadcaster running at http://localhost:${PORT}`);
});
