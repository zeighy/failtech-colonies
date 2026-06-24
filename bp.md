# **Application Blueprint: FAILTECH \- Radial Command (MVP)**

## **1\. Executive Summary**

**Project:** Browser-based multiplayer colony management game.

**Setting:** FAILTECH universe, Post-2200 era. Gritty, survival-industrial aesthetic.

**Core Gameplay:** Strategy, logistics, and production chain management. The player acts as Territory Commander, managing a central hub and expanding radially.

**Architecture:** Server-authoritative, tick-based simulation. Client is a purely presentational layer.

**Target Scale (MVP):** \~5 concurrent users for initial testing and validation.

## **2\. Gameplay & Mechanics (MVP Scope)**

### **2.1 The Radial Colony (Concentric Slot System)**

To achieve the radial Frostpunk/Anno feel while maintaining MVP feasibility, the base is divided into concentric rings.

* **Ring 0 (The Hub):** The central command structure. Dictates maximum colony size and global storage. Cannot be destroyed or moved.  
* **Ring 1 to N:** Expanding rings around the Hub. Each ring has a fixed number of slots (e.g., Ring 1 has 6 slots, Ring 2 has 12 slots).  
* **Adjacency Bonuses:** Buildings gain efficiency bonuses or penalties based on neighboring slots (both laterally within the same ring, and vertically to adjacent rings). This forms the core spatial puzzle.

### **2.2 Resources & Production Chains**

* **Primary Resources:** Scrap, Raw Synthetics, Unpurified Water, Energy.  
* **Secondary Products:** Machined Parts, Clean Water, Rations, Building Materials.  
* **Mechanic:** Buildings consume inputs and produce outputs per tick. If a building lacks input (e.g., Water Purifier lacks Energy), production halts.  
* **Storage:** The Hub has a hard cap on storage. Excess production is lost.

### **2.3 Logistics: The Convoy (Scheduled Import/Export)**

* The colony is not entirely self-sufficient. A planetary supply network ("The Convoy") arrives at scheduled intervals.  
* **Contracts:** Players set up import/export contracts *before* the Convoy arrives.  
* **Economy:** Players trade surplus Secondary Products for credits or rare Primary Resources needed for Hub upgrades.

### **2.4 Initial State, Failure Conditions & Resets**

* **Onboarding:** Upon account creation, the user is assigned a Hub (Ring 0\) with a starter cache of Primary Resources and a basic population count.  
* **Win/Goal State (MVP):** Upgrade the Hub to Level 3 and establish a self-sustaining positive energy and water loop.  
* **Failure State:** If Critical Resources (Rations, Clean Water, Energy) reach 0 and remain there for a set number of ticks, Population Morale reaches 0\. The colony is considered "Abandoned/Failed," forcing a soft reset (lose buildings, keep partial credits).  
* **Manual Reset (MVP Testing):** To facilitate rapid testing, players can manually trigger a complete colony wipe. This instantly clears all constructed buildings, resets the inventory to the initial onboarding state, and purges all pending Work Orders, allowing the player to test new opening strategies or clear soft-locks.

## **3\. System Architecture**

### **3.1 Server-Authoritative Tick System**

* **Tick Rate:** The server processes global game state at regular intervals (e.g., 1 tick \= 1 minute of real time).  
* **Offline Progress:** Because it is server-side, production, consumption, and Convoy arrivals occur regardless of whether the user is logged in.

### **3.2 Client-Server Interaction & Work Orders**

* **The Work Order Queue:** Player commands are not instantaneous. The client sends an intent to the server as a "Work Order."  
* **Validation & Acceptance:** The server intercepts the Work Order, validates ownership, resources, and tech. If valid, the server accepts the order, immediately deducts resources, and queues it.  
* **Execution Delay & Fulfillment:** Actions take a predefined number of ticks to complete, simulating real-world production. The server finalizes the state change once ticks elapse.  
* **Immediate System Actions:** Unlike construction, administrative actions (like the MVP Manual Reset) bypass the Work Order queue. They execute instantly via a direct server request, immediately updating the database state to ensure a clean slate.

### **3.3 Authentication & Data Model**

* **Auth:** Handled natively via PocketBase.  
* **Database Schema (SQLite via PocketBase):**  
  * Users (PocketBase default auth collection)  
  * Colonies (ID, UserID, HubLevel, Credits, Morale, LastTickProcessed)  
  * Colony\_Inventory (ColonyID, ResourceID, Amount)  
  * Colony\_Buildings (ColonyID, RingIndex, SlotIndex, BuildingType, Status)  
  * Colony\_WorkOrders (ID, ColonyID, ActionType, TargetData, TicksRemaining)

### **3.4 Game Configuration & Balancing Data**

* **Data Separation:** Building costs, production rates, tick delays, and adjacency multipliers MUST NOT be hardcoded into the tick engine logic.  
* **Implementation:** A static game\_config.json file stored on the server, or a read-only Config table in PocketBase. This allows developers to tweak balancing during testing without recompiling or altering the core engine.

## **4\. Interface & User Experience (Client)**

### **4.1 Main View (The Radar Map)**

* A top-down, abstracted "radar" or schematic view of the colony. The base structure is rendered using custom HTML/CSS SVGs.  
* **Iconography:** Slots populate with Tabler/Lucide icons to represent building types.  
* Clicking an empty slot triggers an HTMX request that fetches and injects a "Construction" modal.

### **4.2 HUD & Dashboards**

* **Top Bar:** Current credits, energy grid, morale, and Convoy countdown timer.  
* **Left Panel:** Production overview.  
* **Right Panel:** The Logistics Terminal.  
* **Bottom Panel (Action Queue):** A list of active Work Orders showing progress bars.  
* **System Settings:** Includes a "Restart Colony" button. Because this is a destructive action, it will trigger an HTMX-injected confirmation modal ("Are you sure you want to abandon this colony? All progress will be lost.") requiring active user confirmation before executing.

### **4.3 UI Error Handling (HTMX specific)**

* If the server rejects a Work Order (e.g., insufficient funds), the templating server will respond with an HTML snippet representing an error notification (a "Toast" or alert banner).  
* HTMX will catch this response and use the hx-swap-oob (Out of Band Swap) attribute to inject the error message at the top of the screen without disturbing the main Radar Map view.

## **5\. Technology Stack Recommendations (Ultra-Lean MVP)**

* **Backend / Database:** **PocketBase** (Embedded SQLite, Auth, API).  
* **The "Tick" Engine:** A lightweight worker script (Node.js, Python, or Go) running on a cron-like interval alongside PocketBase.  
* **Frontend:** **HTMX** (+ lightweight CSS framework like Tailwind or PicoCSS).  
* **Iconography:** **Tabler Icons** or **Lucide**.  
* **HTML Rendering:** A lightweight templating server (e.g., Express with EJS, Go HTML templates) sitting in front of PocketBase.  
* **Communication:** HTTP requests via HTMX. Server-Sent Events (SSE) to push live tick updates.

## **6\. Deployment Strategy (MVP)**

* **Environment:** A single, low-cost Virtual Private Server (VPS) such as DigitalOcean Droplet, Linode, or Hetzner.  
* **Containerization:** Docker & Docker Compose.  
  * Container 1: PocketBase.  
  * Container 2: HTML Templating Server.  
  * Container 3: Tick Engine Worker.  
* **Proxy:** Nginx or Caddy (acting as a reverse proxy to route traffic and handle SSL certificates via Let's Encrypt).

## **7\. Security Specifications**

* **Auth Protection:** PocketBase API rules restrict data access by ColonyID.  
* **Sanitization:** All inputs via HTMX forms validated by the HTML rendering server.  
* **Transaction Integrity:** The tick worker must process resource deduction and status changes sequentially.

## **8\. Future Considerations (Post-MVP)**

* **Multiplayer Interaction:** Trading resources directly between user colonies.  
* **Hazards:** Weather events or systemic failures.  
* **Audio:** Ambient industrial soundscapes and UI feedback sound effects.  
* **Scaling:** Migrating from PocketBase/SQLite to a dedicated PostgreSQL instance if the player base scales.

