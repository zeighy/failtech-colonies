const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const { db, seedColonyForUser, gameConfig } = require('./db');
const { startEngine } = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup EJS and middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public')); // In case of static assets

app.use(session({
    secret: 'failtech-mvp-secret-key', // Hardcoded for MVP only
    resave: false,
    saveUninitialized: false
}));

// Middleware to check authentication
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        return next();
    }
    res.redirect('/');
}

// Routes
app.get('/', (req, res) => {
    if (req.session.userId) {
        return res.redirect('/game');
    }
    res.render('login', { error: null });
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.render('login', { error: 'Username and password are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const insertUser = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)');
        const result = insertUser.run(username, hashedPassword);

        // Seed new colony for user
        seedColonyForUser(result.lastInsertRowid);

        req.session.userId = result.lastInsertRowid;
        res.redirect('/game');
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.render('login', { error: 'Username already exists' });
        }
        console.error(error);
        res.render('login', { error: 'Registration failed' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.render('login', { error: 'Username and password are required' });
    }

    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.userId = user.id;
            res.redirect('/game');
        } else {
            res.render('login', { error: 'Invalid username or password' });
        }
    } catch (error) {
        console.error(error);
        res.render('login', { error: 'Login failed' });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Main Game Dashboard
app.get('/game', isAuthenticated, (req, res) => {
    const colony = db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(req.session.userId);
    if (!colony) {
        return res.status(404).send("Colony not found.");
    }

    const inventoryRows = db.prepare('SELECT resource_id, amount FROM colony_inventory WHERE colony_id = ?').all(colony.id);
    const inventory = {};
    for (let row of inventoryRows) {
        inventory[row.resource_id] = row.amount;
    }

    const buildings = db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ?').all(colony.id);
    const workOrders = db.prepare('SELECT * FROM colony_work_orders WHERE colony_id = ?').all(colony.id);

    // Prepare map data (Ring 1 for MVP)
    const mapSlots = Array(6).fill(null); // MVP hardcoded 6 slots
    buildings.forEach(b => {
        if (b.ring_index === 1 && b.slot_index >= 0 && b.slot_index < 6) {
            mapSlots[b.slot_index] = gameConfig.buildings[b.building_type];
        }
    });

    workOrders.forEach(w => {
         if (w.action_type === 'build') {
             const data = JSON.parse(w.target_data);
             if (data.ring_index === 1 && data.slot_index >= 0 && data.slot_index < 6) {
                 mapSlots[data.slot_index] = { name: "Under Construction (" + w.ticks_remaining + "t)", type: "construction" };
             }
         }
    });

    res.render('game', { colony, inventory, mapSlots, workOrders, gameConfig, error: null });
});

// Build Endpoint (HTMX)
app.post('/game/build', isAuthenticated, (req, res) => {
    const { ring_index, slot_index, building_type } = req.body;
    const rIdx = parseInt(ring_index);
    const sIdx = parseInt(slot_index);

    const bldgConfig = gameConfig.buildings[building_type];
    if (!bldgConfig) {
        return res.send(`<div id="error-toast" hx-swap-oob="true" class="bg-red-500 text-white p-2 rounded mb-2">Invalid building type</div>`);
    }

    const colony = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(req.session.userId);

    // Check if slot is occupied
    const existingBuilding = db.prepare('SELECT id FROM colony_buildings WHERE colony_id = ? AND ring_index = ? AND slot_index = ?').get(colony.id, rIdx, sIdx);
    const existingWO = db.prepare("SELECT id FROM colony_work_orders WHERE colony_id = ? AND action_type = 'build' AND json_extract(target_data, '$.ring_index') = ? AND json_extract(target_data, '$.slot_index') = ?").get(colony.id, rIdx, sIdx);

    if (existingBuilding || existingWO) {
         return res.send(`<div id="error-toast" hx-swap-oob="true" class="bg-red-500 text-white p-2 rounded mb-2">Slot already occupied</div>`);
    }

    // Check cost
    const transaction = db.transaction(() => {
        let canAfford = true;
        for (let [resId, costAmt] of Object.entries(bldgConfig.cost)) {
            const current = db.prepare('SELECT amount FROM colony_inventory WHERE colony_id = ? AND resource_id = ?').get(colony.id, resId);
            if (!current || current.amount < costAmt) {
                canAfford = false;
                break;
            }
        }

        if (!canAfford) {
            return false;
        }

        // Deduct cost
        for (let [resId, costAmt] of Object.entries(bldgConfig.cost)) {
            db.prepare('UPDATE colony_inventory SET amount = amount - ? WHERE colony_id = ? AND resource_id = ?').run(costAmt, colony.id, resId);
        }

        // Queue Work Order
        db.prepare('INSERT INTO colony_work_orders (colony_id, action_type, target_data, ticks_remaining) VALUES (?, ?, ?, ?)')
            .run(colony.id, 'build', JSON.stringify({ ring_index: rIdx, slot_index: sIdx, building_type }), bldgConfig.constructionTicks);

        return true;
    });

    const success = transaction();

    if (!success) {
        return res.send(`<div id="error-toast" hx-swap-oob="true" class="bg-red-500 text-white p-2 rounded mb-2">Insufficient resources</div>`);
    }

    // Instead of rendering full page or complex HTMX response, we will just trigger a full page refresh via HX-Refresh
    // or return a simple success and let the polling update the UI. For MVP, tell HTMX to refresh.
    res.set('HX-Refresh', 'true');
    res.send('');
});

// Reset Colony Endpoint (Destructive)
app.post('/game/reset', isAuthenticated, (req, res) => {
    const colony = db.prepare('SELECT id FROM colonies WHERE user_id = ?').get(req.session.userId);
    if (!colony) return res.redirect('/game');

    const transaction = db.transaction(() => {
        db.prepare('DELETE FROM colony_work_orders WHERE colony_id = ?').run(colony.id);
        db.prepare('DELETE FROM colony_buildings WHERE colony_id = ?').run(colony.id);
        db.prepare('DELETE FROM colony_inventory WHERE colony_id = ?').run(colony.id);
        db.prepare('DELETE FROM colonies WHERE id = ?').run(colony.id);
        seedColonyForUser(req.session.userId);
    });

    transaction();
    res.redirect('/game');
});

// State Endpoint for polling
app.get('/game/state', isAuthenticated, (req, res) => {
    // Return a partial view containing just the dashboard updates
    const colony = db.prepare('SELECT * FROM colonies WHERE user_id = ?').get(req.session.userId);
    if (!colony) {
        return res.status(404).send("");
    }

    const inventoryRows = db.prepare('SELECT resource_id, amount FROM colony_inventory WHERE colony_id = ?').all(colony.id);
    const inventory = {};
    for (let row of inventoryRows) {
        inventory[row.resource_id] = row.amount;
    }

    const buildings = db.prepare('SELECT * FROM colony_buildings WHERE colony_id = ?').all(colony.id);
    const workOrders = db.prepare('SELECT * FROM colony_work_orders WHERE colony_id = ?').all(colony.id);

    const mapSlots = Array(6).fill(null);
    buildings.forEach(b => {
        if (b.ring_index === 1 && b.slot_index >= 0 && b.slot_index < 6) {
            mapSlots[b.slot_index] = gameConfig.buildings[b.building_type];
        }
    });

    workOrders.forEach(w => {
         if (w.action_type === 'build') {
             const data = JSON.parse(w.target_data);
             if (data.ring_index === 1 && data.slot_index >= 0 && data.slot_index < 6) {
                 mapSlots[data.slot_index] = { name: "Under Construction (" + w.ticks_remaining + "t)", type: "construction" };
             }
         }
    });

    // In a full HTMX implementation, we would render a partial template and swap it.
    // For this MVP step, we will re-render the whole body and let HTMX swap the main content.
    res.render('game_content', { colony, inventory, mapSlots, workOrders, gameConfig });
});

startEngine();

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
