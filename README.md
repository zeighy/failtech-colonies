# FAILTECH - Radial Command (MVP)

## Overview
FAILTECH is a browser-based multiplayer colony management game set in a post-2200 gritty, survival-industrial universe. The player assumes the role of a Territory Commander, managing a central Hub and expanding the base radially through concentric rings. The game challenges players with logistics, resource management, and spatial puzzle elements to ensure the colony's survival against constant consumption drain.

## Features (MVP Scope)
- **Concentric Slot System**: Manage a base divided into rings, starting with a central Hub (Ring 0). Build specialized structures in fixed slots across expanding rings.
- **Resource Management & Production Chains**: Extract primary resources (Scrap, Energy, Unpurified Water) and refine them into secondary products (Machined Parts, Clean Water, Rations) to keep the population alive.
- **Server-Authoritative Tick Simulation**: A reliable, backend-driven tick engine evaluates production, consumption, and work orders continuously.
- **HTMX-driven UI**: A lightweight, fast interface featuring a radar map, live resource tracking, and out-of-band error notifications without requiring heavy frontend frameworks.
- **Strategic Adjacency**: Positioning matters. Group related structures together to boost efficiency and optimize production loops.

## Tech Stack
- **Backend**: Node.js, Express
- **Database**: SQLite (via `better-sqlite3`)
- **Templating**: EJS
- **Frontend Interactivity**: HTMX, Tailwind CSS, custom SVG/CSS visualizations
- **Authentication**: `express-session`, `bcrypt`

## Architecture
The application acts as a single Node.js monolith for the MVP, combining:
1. **The Game Engine** (`engine.js`): An isolated tick loop running at a set interval that processes work orders, tallies resource production/consumption, and enforces the game's survival mechanics.
2. **The Database** (`db.js`): Uses a local SQLite database in WAL mode for quick, concurrent reads/writes for user authentication, colony state, inventory, and building locations.
3. **The Web Server** (`server.js`): Handles routing, renders EJS templates, manages user sessions, and exposes endpoints designed to interact seamlessly with HTMX requests from the client.

## Setup Guide

### Prerequisites
- Node.js (v18+)
- npm

### Installation
1. Clone the repository and enter the directory:
   ```bash
   git clone <repository_url>
   cd failtech-colonies
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the application. The database (`failtech.db`) will be automatically initialized and seeded on the first run.
   ```bash
   node server.js
   ```
4. Access the game by navigating to `http://localhost:3000` in your web browser. Register a new commander to start your first colony.

## License
ISC
