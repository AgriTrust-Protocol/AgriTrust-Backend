const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
  res.json({ 
    project: 'Grant Stream', 
    status: 'Tracking Grants', 
    contract: 'CD6OGC46OFCV52IJQKEDVKLX5ASA3ZMSTHAAZQIPDSJV6VZ3KUJDEP4D' 
  });
});

app.listen(port, () => console.log('Grant API running'));
