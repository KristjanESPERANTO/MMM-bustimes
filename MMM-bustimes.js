/* global Module */
/* MagicMirror²
 * Module: BusTimes
 *
 * By Cirdan.
 *
 */
Module.register("MMM-bustimes", {

    scheduledTimer: -1,

    // Default module config.
    defaults: {
        animationSpeed: 1000,

        apiBase: "https://v0.ovapi.nl",
        timingPointEndpoint: "tpc",
        stopAreaEndpoint: "stopareacode",
        departuresOnlySuffix: "departures",

        refreshInterval: 5 * 1000 * 60, // refresh every 5 minutes
        timeFormat: "HH:mm",

        destinations: null,
        departures: 3,

        showTownName: false,
        showOnlyDepartures: true,
        showDelay: false,
        showHeader: false,
        alwaysShowStopName: true,
        showTimingPointIcon: false,
        showTransportTypeIcon: false,
        showLiveIcon: false,
        showAccessible: false,
        showOperator: false,

        transportTypeIcons: {
            "BUS": "bus",
            "TRAM": "train",
            "METRO": "subway",
            "BOAT": "ship",
            "default": "question-circle"
        },

	timingpointTypeIcons: {
            "WHEELCHAIR": "wheelchair",
            "VISUAL": "blind",
            "default": "sign"
	},

        debug: false
    },

    // Define required scripts.
    getScripts: function() {
        return ["moment.js"];
    },

    // Define required scripts.
    getStyles: function() {
        return ["MMM-bustimes.css", "font-awesome.css"];
    },

    // Define required translations.
    getTranslations: function() {
        return {
            en: "translations/en.json",
            nl: "translations/nl.json",
            it: "translations/it.json",
        };
    },

    // Define start sequence.
    start: function() {
        Log.info("Starting module: " + this.name);

        // Set locale.
        moment.locale(config.language);

        this.errorMsg = "";
        this.departures = {};

        if (!Array.isArray(this.config.destinations)) {
            this.config.destinations = [];
        }

        // Preserve backwards compatibly
        if (this.config.timingPointCode === undefined && this.config.timepointcode) {
            this.config.timingPointCode = this.config.timepointcode;
            this.config.timepointcode = undefined;
        }
        if (this.config.departures === undefined && this.config.departs) {
            this.config.departures = this.config.departs;
            this.config.departs = undefined;
        }

        if (!this.config.timingPointCode && !this.config.stopAreaCode) {
            this.errorMsg = this.translate("notSet");
            this.updateDom();
            return;
        }

        if (!["small", "medium", "large"].includes(this.config.displaymode)) {
            this.errorMsg = this.translate("invalDisplayMode");
            this.updateDom();
            return;
        }

        this.resume();
        this.requestData();
    },

    /* suspend()
     * Disable refreshing.
     */
    suspend: function() {
        if (this.scheduledTimer != -1) {
            if (this.config.debug)
                Log.info(this.name + ": Canceling updates");
            clearInterval(scheduledTimer);
            this.scheduledTimer = -1;
        }
    },

    /* resume()
     * Enable automatic refreshing.
     */
    resume: function() {
        if (this.scheduledTimer == -1) {
            if (this.config.debug)
                Log.info(this.name + ": Scheduling updates");
            var self = this;
            this.scheduledTimer = setInterval(function() {
                self.requestData();
            }, this.config.refreshInterval);
        }
    },

    /*
     * Returns the departure time as a string. Depending on the config, this may
     * either be the time itself, or the scheduled time and the expected offset
     * in minutes.
     */
    getDepartureTime: function(departure) {
        let time = "";
        if (this.config.showDelay) {
            const plannedTime = moment(departure.TargetDepartureTime);
            const liveTime = moment(departure.ExpectedDepartureTime);
            const timeDiff = moment.duration(liveTime.diff(plannedTime));

            // Round down minutes, to be pessimistic for early buses,
            // and optimistic for delayed buses (it's better to arrive
            // early at bus stop, rather than late and miss bus).
            const minutesDiff = Math.abs(Math.floor(timeDiff.asMinutes()));

            // We take the absolute value of minutes and use a bigger
            // (clearer) minus(-like) sign for early departures.
            const sign = liveTime.isBefore(plannedTime) ? "&ndash;" : "+";

            time = plannedTime.format(this.config.timeFormat);
            if (minutesDiff > 0)
                time += sign + minutesDiff;
        } else {
            time = moment(departure.ExpectedDepartureTime).format(this.config.timeFormat);
        }
        return time;
    },

    createEmptyTable: function(className) {
        const table = document.createElement("table");
        table.className = "small thin light";
        if (className)
            table.className += " " + className;
        return table;
    },

    createRow: function(table) {
        const row = document.createElement("tr");
        table.appendChild(row);
        return row;
    },

    createCell: function(row, content, className, cellType = "td") {
        const cell = document.createElement(cellType);
        row.appendChild(cell);
        if (content)
            cell.innerHTML = content;
        if (className)
            cell.className = className;
        return cell;
    },

    createIcon: function(iconName) {
        const icon = document.createElement("span");
        icon.className = "fa fa-" + iconName;
        return icon;
    },

    createTransportTypeIconCell: function(row, transportType) {
        const iconName = this.config.transportTypeIcons[transportType] ||
                       this.config.transportTypeIcons["default"];
        const icon = this.createIcon(iconName);
        const cell = this.createCell(row, null, "transporttype");
        cell.appendChild(icon);
        return cell
    },

    createTransportTypeIcon: function(container, transportType, insert = true) {
        const iconName = this.config.transportTypeIcons[transportType] ||
                       this.config.transportTypeIcons["default"];
        const icon = this.createIcon(iconName);
        icon.className += " transporticon";
        const lastchild = container.lastChild;
        insert ? container.insertBefore(icon, lastchild) : container.appendChild(icon);
     },

    createTimingPointIcon: function(container, timingPointType, insert = true) {
        const iconName = this.config.timingpointTypeIcons[timingPointType] ||
                       this.config.timingpointTypeIcons["default"];
        const icon = this.createIcon(iconName);
        icon.className += (timingPointType == "default") ? " timingpointicon" : " accessibilityicon";
        const lastchild = container.lastChild;
        insert ? container.insertBefore(icon, lastchild) : container.appendChild(icon);
     },

    /*
     * Create an icon representing the shown info is live if the info has been
     * updated in the last 10 minutes.
     */
    createLiveIcon: function(container, lastUpdateTimeStamp) {
        const lastUpdate = moment(lastUpdateTimeStamp);
        const now = moment();
        const timeSinceLastUpdate = moment.duration(now.diff(lastUpdate));
        if (timeSinceLastUpdate.asMinutes() < 10) {
            //"wifi' icon will be transformed by use of CSS to display a 45 degree rotated icon
            const icon = this.createIcon("wifi");
            icon.className += " liveicon";
            container.appendChild(icon);
        }
    },

    /*
     * Create the small table for departures, with a single row per stop,
     * showing the earliest departure from that stop. Destination not displayed.
     */
    createSmallTable: function(timingPointNames) {
        const table = this.createEmptyTable("ovtable-small");

        for (const timingPointName of timingPointNames) {
            const departure = this.departures[timingPointName][0];

            const row = this.createRow(table);
            if (this.config.alwaysShowStopName || timingPointNames.length > 1) {
                const stop = this.createCell(row, timingPointName, "stopname");
                if (this.config.showTimingPointIcon)
                    this.createTimingPointIcon(stop, "default");
                if (this.config.showAccessible) {
                    if (departure.TimingPointWheelChairAccessible)
                        this.createTimingPointIcon(stop, "WHEELCHAIR");
                    if (departure.TimingPointVisualAccessible)
                        this.createTimingPointIcon(stop, "VISUAL");
                }
            }
            if (this.config.showTransportTypeIcon)
                this.createTransportTypeIconCell(row, departure.TransportType);
            const line = this.createCell(row, departure.LinePublicNumber, "line");
            if (this.config.showAccessible) {
                if (departure.LineWheelChairAccessible)
                    this.createTimingPointIcon(line, "WHEELCHAIR", false);
            }
            if (this.config.showOperator)
                this.createCell(row, departure.Operator, "operator");
            const time = this.createCell(row, this.getDepartureTime(departure), "time");

            if (this.config.showLiveIcon)
                this.createLiveIcon(time, departure.LastUpdateTimeStamp);
        }
        return table;
    },

    /*
     * Create the medium table for departures, with two rows per stop, one
     * showing the stop name and the second showing N upcoming departures.
     * Destination not displayed.
     */
    createMediumTable: function(timingPointNames) {
        const table = this.createEmptyTable("ovtable-medium");

        const extraCols = this.config.showTransportTypeIcon ? 1 : 0;
        const extraOpp = this.config.showOperator ? 1 : 0;

        for (const timingPointName of timingPointNames) {
            const timingPoint = this.departures[timingPointName];

            /* Padding the table with minimal 3 'empty' blocks of cells, this keeps the table aligned when departures < 3.
             */
            const extraCells = (this.config.departures < 3) // Test 1
                ? 3 - this.config.departures //T1=true: minimal 3 cells
                : (timingPoint.length < this.config.departures) //T1=false: Test 2
                ? this.config.departures - timingPoint.length //T2=true: substract
                : 0; //T2=false: no extra cells needed

            if (this.config.alwaysShowStopName || timingPointNames.length > 1) {
                const stopRow = this.createRow(table);
                const cell = this.createCell(stopRow, timingPointName, "stopname");
                if  (this.config.showTimingPointIcon || this.config.showAccessible)
                    cell.innerHTML = "&nbsp;" + cell.innerHTML;
                if (this.config.showTimingPointIcon)
                    this.createTimingPointIcon(cell, "default");
                if (this.config.showAccessible) {
                    if (timingPoint[0].TimingPointWheelChairAccessible)
                        this.createTimingPointIcon(cell, "WHEELCHAIR");
                    if (timingPoint[0].TimingPointVisualAccessible)
                        this.createTimingPointIcon(cell, "VISUAL");
                }
                cell.colSpan = (2 + extraCols + extraOpp) * (this.config.departures + extraCells);
            }

            const row = this.createRow(table);

            // Add spacer cells when below 3 departures, and include an extra cell if Timingpoint icon is showed.
            for (let i = 0; i < (2 + extraCols + extraOpp) * extraCells; i++) {
                const spacer = this.createCell (row, '&nbsp;', "spacer");
            }

            for (let i = 0; i < this.config.departures && i in timingPoint; i++) {
                const departure = timingPoint[i];

                if (this.config.showTransportTypeIcon)
                    this.createTransportTypeIconCell(row, departure.TransportType);
                const line = this.createCell(row, departure.LinePublicNumber, "line");
                if (this.config.showAccessible) {
                    if (departure.LineWheelChairAccessible)
                        this.createTimingPointIcon(line, "WHEELCHAIR", false);
                }
                if (this.config.showOperator)
                    this.createCell(row, departure.Operator, "operator");
                const time = this.createCell(row, this.getDepartureTime(departure), "time");

                if (this.config.showLiveIcon)
                    this.createLiveIcon(time, departure.LastUpdateTimeStamp);
            }
        }
        return table;
    },

    /*
     * Create the large table for departures, with N upcoming departures per
     * stop, each on their own row, including additional information such as the
     * destination.
     */
    createLargeTable: function(timingPointNames) {
        const table = this.createEmptyTable("ovtable-large");

        const extraCols = this.config.showTransportTypeIcon ? 1 : 0;
        const extraOpp = this.config.showOperator ? 1 : 0;

        if (this.config.showHeader) {
            const row = this.createRow(table);
            const cell = this.createCell(row, this.translate("line"), null, "th");
            cell.colSpan = 1 + extraCols + extraOpp;
            var text = this.translate("destination")
            if (this.config.alwaysShowStopName || timingPointNames.length > 1)
               text = this.translate("stopname") + " / " + text; 
            this.createCell(row, text, null, "th");
            this.createCell(row, this.translate("departure"), null, "th");
        }

        for (const timingPointName of timingPointNames) {
            const timingPoint = this.departures[timingPointName];

            if (this.config.alwaysShowStopName || timingPointNames.length > 1) {
                const stopRow = this.createRow(table);
                const cell = this.createCell(stopRow, timingPointName, "stopname");
                if (this.config.showTimingPointIcon)
                    this.createTimingPointIcon(cell, "default");
                if (this.config.showAccessible) {
                    if (timingPoint[0].TimingPointWheelChairAccessible)
                        this.createTimingPointIcon(cell, "WHEELCHAIR");
                    if (timingPoint[0].TimingPointVisualAccessible)
                        this.createTimingPointIcon(cell, "VISUAL");
                }
                cell.colSpan = 3 + extraCols + extraOpp;
            }

            for (let i = 0; i < this.config.departures && i in timingPoint; i++) {
                const departure = timingPoint[i];

                const row = this.createRow(table);
                if (this.config.showTransportTypeIcon)
                    this.createTransportTypeIconCell(row, departure.TransportType);
                const line = this.createCell(row, departure.LinePublicNumber, "line");
                if (this.config.showAccessible) {
                    if (departure.LineWheelChairAccessible)
                        this.createTimingPointIcon(line, "WHEELCHAIR", false);
                }
                if (this.config.showOperator)
                    this.createCell(row, departure.Operator, "operator");
                const dest = this.createCell(row, departure.Destination, "destination");
                const time = this.createCell(row, this.getDepartureTime(departure), "time");

                if (this.config.showLiveIcon)
                    this.createLiveIcon(time, departure.LastUpdateTimeStamp);
            }
        }
        return table;
    },

    /*
     * Returns a DOM object that shows the given message.
     */
    createMessage: function(message) {
        const div = document.createElement("div");
        div.innerHTML = message;
        div.className = "dimmed light small";
        return div;
    },

    /*
     * Constructs the content to be shown for this module. This will either be
     * a message (e.g., an error), or a table corresponding to the display mode.
     */
    createContent: function() {
        if (this.errorMsg)
            return this.createMessage(this.errorMsg);
        if (!this.loaded)
            return this.createMessage(this.translate("LOADING"));

        const timingPointNames = Object.keys(this.departures);
        timingPointNames.sort();

        if (timingPointNames.length == 0)
            return this.createMessage(this.translate("noData"));

        const tableCreators = {
            small: this.createSmallTable,
            medium: this.createMediumTable,
            large: this.createLargeTable,
        };
        return tableCreators[this.config.displaymode].call(this, timingPointNames);
    },

    // Override dom generator.
    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = "bustimes";
        wrapper.appendChild(this.createContent());
        return wrapper;
    },

    /*
     * Asks the node helper to request new data.
     */
    requestData: function() {
        if (this.config.debug)
            Log.info(this.name + ": Requested data");

        this.sendSocketNotification('GETDATA', {
            identifier: this.identifier,
            config: this.config
        });
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "DATA" && payload.identifier === this.identifier) {
            this.departures = payload.data;
            this.loaded = true;
            this.errorMsg = "";
            this.updateDom(this.config.animationSpeed);
        }

        if (notification === "ERROR" && payload.identifier === this.identifier) {
            if (this.config.debug)
                Log.warn(this.name + ": Error fetching departures: " + payload.error);
            this.errorMsg = this.translate("error");
            this.updateDom(this.config.animationSpeed);
        }
    }

});
