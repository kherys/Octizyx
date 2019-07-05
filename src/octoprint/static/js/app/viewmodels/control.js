$(function() {
    function ControlViewModel(parameters) {
        var self = this;

        self.loginState = parameters[0];
        self.settings = parameters[1];

        self._createToolEntry = function() {
            var entry = {
                name: ko.observable(),
                key: ko.observable(),
                actual: ko.observable(0),
                target: ko.observable(0),
                offset: ko.observable(0),
                newTarget: ko.observable(),
                newOffset: ko.observable()
            };

            entry.newTargetValid = ko.pureComputed(function() {
                var value = entry.newTarget();

                try {
                    value = parseInt(value);
                } catch (exc) {
                    return false;
                }

                return (value >= 0 && value <= 999);
            });


            entry.newOffsetValid = ko.pureComputed(function() {
                var value = entry.newOffset();

                try {
                    value = parseInt(value);
                } catch (exc) {
                    return false;
                }

                return (-50 <= value <= 50);
            });

            entry.offset.subscribe(function(newValue) {
                if (self.changingOffset.item !== undefined && self.changingOffset.item.key() === entry.key()) {
                    // if our we currently have the offset dialog open for this entry and the offset changed
                    // meanwhile, update the displayed value in the dialog
                    self.changingOffset.offset(newValue);
                }
            });

            return entry;
        };


        self.changingOffset = {
            offset: ko.observable(0),
            newOffset: ko.observable(0),
            name: ko.observable(""),
            item: undefined,

            title: ko.pureComputed(function() {
                return _.sprintf(gettext("Changing Offset of %(name)s"), {name: self.changingOffset.name()});
            }),
            description: ko.pureComputed(function() {
                return _.sprintf(gettext("Use the form below to specify a new offset to apply to all temperature commands sent from printed files for \"%(name)s\""),
                    {name: self.changingOffset.name()});
            })
        };
        self.changeOffsetDialog = undefined;

        self.isErrorOrClosed = ko.observable(undefined);
        self.isOperational = ko.observable(undefined);
        self.isPrinting = ko.observable(undefined);
        self.isPaused = ko.observable(undefined);
        self.isError = ko.observable(undefined);
        self.isReady = ko.observable(undefined);
        self.isLoading = ko.observable(undefined);

        self.temperature_profiles = self.settings.temperature_profiles;
        self.temperature_cutoff = self.settings.temperature_cutoff;

        self.extrusionAmount = ko.observable(undefined);
        self.controls = ko.observableArray([]);

        self.distances = ko.observableArray([0.1, 1, 10, 100]);
        self.distance = ko.observable(10);

        self.tools = ko.observableArray([]);
        self.hasTools = ko.pureComputed(function() {
            return self.tools().length > 0;
        });
        self.hasBed = ko.observable(true);
        self.hasChamber = ko.observable(false);
        self.visible = ko.pureComputed(function() {
            return self.hasTools() || self.hasBed();
        });

        self.bedTemp = self._createToolEntry();
        self.bedTemp["name"](gettext("Bed"));
        self.bedTemp["key"]("bed");

        self.chamberTemp = self._createToolEntry();
        self.chamberTemp["name"](gettext("Chamber"));
        self.chamberTemp["key"]("chamber");

        self.heaterOptions = ko.observable({});

        self._printerProfileInitialized = false;
        self._currentTemperatureDataBacklog = [];
        self._historyTemperatureDataBacklog = [];

        self.feedRate = ko.observable(100);
        self.flowRate = ko.observable(100);

        self.feedbackControlLookup = {};

        self.controlsFromServer = [];
        self.additionalControls = [];

        self.webcamDisableTimeout = undefined;
        self.webcamLoaded = ko.observable(false);
        self.webcamError = ko.observable(false);

        self.keycontrolActive = ko.observable(false);
        self.keycontrolHelpActive = ko.observable(false);
        self.keycontrolPossible = ko.pureComputed(function () {
            return self.settings.feature_keyboardControl() && self.isOperational() && !self.isPrinting() && self.loginState.isUser() && !$.browser.mobile;
        });
        self.showKeycontrols = ko.pureComputed(function () {
            return self.keycontrolActive() && self.keycontrolPossible();
        });

        self.webcamRatioClass = ko.pureComputed(function() {
            if (self.settings.webcam_streamRatio() == "4:3") {
                return "ratio43";
            } else {
                return "ratio169";
            }
        });

                self._printerProfileUpdated = function() {
            var graphColors = ["red", "orange", "green", "brown", "purple"];
            var heaterOptions = {};
            var tools = [];
            var color;

            // tools
            var currentProfileData = self.settings.printerProfiles.currentProfileData();
            var numExtruders = (currentProfileData ? currentProfileData.extruder.count() : 0);
            var sharedNozzle = (currentProfileData ? currentProfileData.extruder.sharedNozzle() : false);
            if (numExtruders && numExtruders > 1 && !sharedNozzle) {
                // multiple extruders
                for (var extruder = 0; extruder < numExtruders; extruder++) {
                    color = graphColors.shift();
                    if (!color) color = "black";
                    heaterOptions["tool" + extruder] = {name: "T" + extruder, color: color};

                    if (tools.length <= extruder || !tools[extruder]) {
                        tools[extruder] = self._createToolEntry();
                    }
                    tools[extruder]["name"](gettext("Tool") + " " + extruder);
                    tools[extruder]["key"]("tool" + extruder);
                }
            } else if (numExtruders === 1 || sharedNozzle) {
                // only one extruder, no need to add numbers
                color = graphColors[0];
                heaterOptions["tool0"] = {name: "T", color: color};

                if (tools.length < 1 || !tools[0]) {
                    tools[0] = self._createToolEntry();
                }
                tools[0]["name"](gettext("Tool"));
                tools[0]["key"]("tool0");
            }

            // print bed
            if (currentProfileData && currentProfileData.heatedBed()) {
                self.hasBed(true);
                heaterOptions["bed"] = {name: gettext("Bed"), color: "blue"};
            } else {
                self.hasBed(false);
            }

            // heated chamber
            if (currentProfileData && currentProfileData.heatedChamber()) {
                self.hasChamber(true);
                heaterOptions["chamber"] = {name: gettext("Chamber"), color: "black"};
            } else {
                self.hasChamber(false);
            }

            // write back
            self.heaterOptions(heaterOptions);
            self.tools(tools);

            if (!self._printerProfileInitialized) {
                self._triggerBacklog();
            }
            self.updatePlot();
        };


        self.settings.printerProfiles.currentProfileData.subscribe(function () {
            self._printerProfileUpdated();
            self._updateExtruderCount();
            self.settings.printerProfiles.currentProfileData().extruder.count.subscribe(self._updateExtruderCount);

        });
        self._updateExtruderCount = function () {
            var tools = [];

            var numExtruders = self.settings.printerProfiles.currentProfileData().extruder.count();
            if (numExtruders > 1) {
                // multiple extruders
                for (var extruder = 0; extruder < numExtruders; extruder++) {
                    tools[extruder] = self._createToolEntry();
                    tools[extruder]["name"](gettext("Tool") + " " + extruder);
                    tools[extruder]["key"]("tool" + extruder);
                }
            } else if (numExtruders === 1) {
                // only one extruder, no need to add numbers
                tools[0] = self._createToolEntry();
                tools[0]["name"](gettext("Hotend"));
                tools[0]["key"]("tool0");
            }

            self.tools(tools);
        };

        self.fromCurrentData = function (data) {
            self._processStateData(data.state);
            if (!self._printerProfileInitialized) {
                self._currentTemperatureDataBacklog.push(data);
            } else {
                self._processTemperatureUpdateData(data.serverTime, data.temps);
            }
            self._processOffsetData(data.offsets);
        };

        self.fromHistoryData = function (data) {
            self._processStateData(data.state);
            if (!self._printerProfileInitialized) {
                self._historyTemperatureDataBacklog.push(data);
            } else {
                self._processTemperatureHistoryData(data.serverTime, data.temps);
            }
            self._processOffsetData(data.offsets);
            self._processHistoryLogData(data.logs);

        };

        self._triggerBacklog = function() {
            _.each(self._historyTemperatureDataBacklog, function(data) {
                self._processTemperatureHistoryData(data.serverTime, data.temps);
            });
            _.each(self._currentTemperatureDataBacklog, function(data) {
                self._processTemperatureUpdateData(data.serverTime, data.temps);
            });
            self._historyTemperatureDataBacklog = [];
            self._currentTemperatureDataBacklog = [];
            self._printerProfileInitialized = true;
        };

        self._processStateData = function (data) {
            self.isErrorOrClosed(data.flags.closedOrError);
            self.isOperational(data.flags.operational);
            self.isPaused(data.flags.paused);
            self.isPrinting(data.flags.printing);
            self.isError(data.flags.error);
            self.isReady(data.flags.ready);
            self.isLoading(data.flags.loading);
        };

        self._processTemperatureUpdateData = function(serverTime, data) {
            if (data.length === 0)
                return;

            var lastData = data[data.length - 1];

            var tools = self.tools();
            for (var i = 0; i < tools.length; i++) {
                if (lastData.hasOwnProperty("tool" + i)) {
                    tools[i]["actual"](lastData["tool" + i].actual);
                    tools[i]["target"](lastData["tool" + i].target);
                } else {
                    tools[i]["actual"](0);
                    tools[i]["target"](0);
                }
            }

            if (lastData.hasOwnProperty("bed")) {
                self.bedTemp["actual"](lastData.bed.actual);
                self.bedTemp["target"](lastData.bed.target);
            } else {
                self.bedTemp["actual"](0);
                self.bedTemp["target"](0);
            }

            if (lastData.hasOwnProperty("chamber")) {
                self.chamberTemp["actual"](lastData.chamber.actual);
                self.chamberTemp["target"](lastData.chamber.target);
            } else {
                self.chamberTemp["actual"](0);
                self.chamberTemp["target"](0);
            }

            if (!CONFIG_TEMPERATURE_GRAPH) return;

            self.temperatures = self._processTemperatureData(serverTime, data, self.temperatures);
            self.updatePlot();
        };

        self._processTemperatureHistoryData = function(serverTime, data) {
            self.temperatures = self._processTemperatureData(serverTime, data);
            self.updatePlot();
        };

        self._processOffsetData = function(data) {
            var tools = self.tools();
            for (var i = 0; i < tools.length; i++) {
                if (data.hasOwnProperty("tool" + i)) {
                    tools[i]["offset"](data["tool" + i]);
                } else {
                    tools[i]["offset"](0);
                }
            }

            if (data.hasOwnProperty("bed")) {
                self.bedTemp["offset"](data["bed"]);
            } else {
                self.bedTemp["offset"](0);
            }

            if (data.hasOwnProperty("chamber")) {
                self.chamberTemp["offset"](data["chamber"]);
            } else {
                self.chamberTemp["offset"](0);
            }
        };

                self._processTemperatureData = function(serverTime, data, result) {
            var types = _.keys(self.heaterOptions());
            var clientTime = Date.now();

            // make sure result is properly initialized
            if (!result) {
                result = {};
            }

            _.each(types, function(type) {
                if (!result.hasOwnProperty(type)) {
                    result[type] = {actual: [], target: []};
                }
                if (!result[type].hasOwnProperty("actual")) result[type]["actual"] = [];
                if (!result[type].hasOwnProperty("target")) result[type]["target"] = [];
            });

            // convert data
            _.each(data, function(d) {
                var timeDiff = (serverTime - d.time) * 1000;
                var time = clientTime - timeDiff;
                _.each(types, function(type) {
                    if (!d[type]) return;
                    result[type].actual.push([time, d[type].actual]);
                    result[type].target.push([time, d[type].target]);
                })
            });

            var temperature_cutoff = self.temperature_cutoff();
            if (temperature_cutoff !== undefined) {
                var filterOld = function(item) {
                    return item[0] >= clientTime - temperature_cutoff * 60 * 1000;
                };

                _.each(_.keys(self.heaterOptions()), function(d) {
                    result[d].actual = _.filter(result[d].actual, filterOld);
                    result[d].target = _.filter(result[d].target, filterOld);
                });
            }

            return result;
        };

        self.profileText = function(heater, profile) {
            var text = gettext("Set %(name)s (%(value)s)");

            var value;
            if (heater.key() === "bed") {
                value = profile.bed;
            } else if (heater.key() === "chamber") {
                value = profile.chamber;
            } else {
                value = profile.extruder;
            }

            if (value === 0 || value === undefined) {
                value = gettext("Off");
            } else {
                value = "" + value + "°C";
            }

            return _.sprintf(text, {name: profile.name, value: value});
        };

        self.updatePlot = function() {
            var graph = $("#temperature-graph");
            if (!graph.length) return; // no graph
            if (!self.plot) return; // plot not yet initialized

            var plotInfo = self._getPlotInfo();
            if (plotInfo === undefined) return;

            var newMax = Math.max(Math.max.apply(null, plotInfo.max) * 1.1, 310);
            if (newMax !== self.plot.getAxes().yaxis.max) {
                // re-init (because flot apparently has NO way to change the max value of an axes :/)
                self._initializePlot(true, plotInfo);
            } else {
                // update the data
                self.plot.setData(plotInfo.data);
                self.plot.setupGrid();
                self.updateLegend(self._replaceLegendLabel);
                self.plot.draw();
            }
        };

        self._initializePlot = function(force, plotInfo) {
            var graph = $("#temperature-graph");
            if (!graph.length) return; // no graph
            if (self.plot && !force) return; // already initialized

            plotInfo = plotInfo || self._getPlotInfo();
            if (plotInfo === undefined) return;

            // we don't have a plot yet, we need to set stuff up
            var options = {
                yaxis: {
                    min: 0,
                    max: Math.max(Math.max.apply(null, plotInfo.max) * 1.1, 310),
                    ticks: 10,
                    tickFormatter: function(val, axis) {
                        if (val === undefined || val === 0)
                            return "";
                        return val + "°C";
                    }
                },
                xaxis: {
                    mode: "time",
                    minTickSize: [2, "minute"],
                    tickFormatter: function(val, axis) {
                        if (val === undefined || val === 0)
                            return ""; // we don't want to display the minutes since the epoch if not connected yet ;)

                        // current time in milliseconds in UTC
                        var timestampUtc = Date.now();

                        // calculate difference in milliseconds
                        var diff = timestampUtc - val;

                        // convert to minutes
                        var diffInMins = Math.round(diff / (60 * 1000));
                        if (diffInMins === 0) {
                            // don't write anything for "just now"
                            return "";
                        } else if (diffInMins < 0) {
                            // we can't look into the future
                            return "";
                        } else {
                            return "- " + diffInMins + " " + gettext("min");
                        }
                    }
                },
                legend: {
                    position: "sw",
                    noColumns: 2,
                    backgroundOpacity: 0
                }
            };

            if (!OctoPrint.coreui.browser.mobile) {
                options["crosshair"] = { mode: "x" };
                options["grid"] = { hoverable: true, autoHighlight: false };
            }

            self.plot = $.plot(graph, plotInfo.data, options);
        };



        self.onEventSettingsUpdated = function (payload) {
            // the webcam url might have changed, make sure we replace it now if the tab is focused
            self._enableWebcam();
            self.requestData();
        };

        self.onEventRegisteredMessageReceived = function(payload) {
            if (payload.key in self.feedbackControlLookup) {
                var outputs = self.feedbackControlLookup[payload.key];
                _.each(payload.outputs, function(value, key) {
                    if (outputs.hasOwnProperty(key)) {
                        outputs[key](value);
                    }
                });
            }
        };

        self.rerenderControls = function () {
            var allControls = self.controlsFromServer.concat(self.additionalControls);
            self.controls(self._processControls(allControls))
        };

        self.requestData = function () {
            OctoPrint.control.getCustomControls()
                .done(function(response) {
                    self._fromResponse(response);
                });
        };

        self._fromResponse = function (response) {
            self.controlsFromServer = response.controls;
            self.rerenderControls();
        };

        self._processControls = function (controls) {
            for (var i = 0; i < controls.length; i++) {
                controls[i] = self._processControl(controls[i]);
            }
            return controls;
        };

        self._processControl = function (control) {
            if (control.hasOwnProperty("processed") && control.processed) {
                return control;
            }

            if (control.hasOwnProperty("template") && control.hasOwnProperty("key") && control.hasOwnProperty("template_key") && !control.hasOwnProperty("output")) {
                control.output = ko.observable(control.default || "");
                if (!self.feedbackControlLookup.hasOwnProperty(control.key)) {
                    self.feedbackControlLookup[control.key] = {};
                }
                self.feedbackControlLookup[control.key][control.template_key] = control.output;
            }

            if (control.hasOwnProperty("children")) {
                control.children = ko.observableArray(self._processControls(control.children));
                if (!control.hasOwnProperty("layout") || !(control.layout == "vertical" || control.layout == "horizontal" || control.layout == "horizontal_grid")) {
                    control.layout = "vertical";
                }

                if (!control.hasOwnProperty("collapsed")) {
                    control.collapsed = false;
                }
            }

            if (control.hasOwnProperty("input")) {
                var attributeToInt = function(obj, key, def) {
                    if (obj.hasOwnProperty(key)) {
                        var val = obj[key];
                        if (_.isNumber(val)) {
                            return val;
                        }

                        var parsedVal = parseInt(val);
                        if (!isNaN(parsedVal)) {
                            return parsedVal;
                        }
                    }
                    return def;
                };

                _.each(control.input, function (element) {
                    if (element.hasOwnProperty("slider") && _.isObject(element.slider)) {
                        element.slider["min"] = attributeToInt(element.slider, "min", 0);
                        element.slider["max"] = attributeToInt(element.slider, "max", 255);

                        // try defaultValue, default to min
                        var defaultValue = attributeToInt(element, "default", element.slider.min);

                        // if default value is not within range of min and max, correct that
                        if (!_.inRange(defaultValue, element.slider.min, element.slider.max)) {
                            // use bound closer to configured default value
                            defaultValue = defaultValue < element.slider.min ? element.slider.min : element.slider.max;
                        }

                        element.value = ko.observable(defaultValue);
                    } else {
                        element.slider = false;
                        element.value = ko.observable((element.hasOwnProperty("default")) ? element["default"] : undefined);
                    }
                });
            }

            var js;
            if (control.hasOwnProperty("javascript")) {
                js = control.javascript;

                // if js is a function everything's fine already, but if it's a string we need to eval that first
                if (!_.isFunction(js)) {
                    control.javascript = function (data) {
                        eval(js);
                    };
                }
            }

            if (control.hasOwnProperty("enabled")) {
                js = control.enabled;

                // if js is a function everything's fine already, but if it's a string we need to eval that first
                if (!_.isFunction(js)) {
                    control.enabled = function (data) {
                        return eval(js);
                    }
                }
            }

            if (!control.hasOwnProperty("additionalClasses")) {
                control.additionalClasses = "";
            }

            control.processed = true;
            return control;
        };

        self.isCustomEnabled = function (data) {
            if (data.hasOwnProperty("enabled")) {
                return data.enabled(data);
            } else {
                return self.isOperational() && self.loginState.isUser();
            }
        };

        self.clickCustom = function (data) {
            var callback;
            if (data.hasOwnProperty("javascript")) {
                callback = data.javascript;
            } else {
                callback = self.sendCustomCommand;
            }

            if (data.confirm) {
                showConfirmationDialog({
                    message: data.confirm,
                    onproceed: function (e) {
                        callback(data);
                    }
                });
            } else {
                callback(data);
            }
        };


        self.sendJogCommand = function (axis, multiplier, distance) {
            if (typeof distance === "undefined")
                distance = self.distance();
            if (self.settings.printerProfiles.currentProfileData() && self.settings.printerProfiles.currentProfileData()["axes"] && self.settings.printerProfiles.currentProfileData()["axes"][axis] && self.settings.printerProfiles.currentProfileData()["axes"][axis]["inverted"]()) {
                multiplier *= -1;
            }

            var data = {};
            data[axis] = distance * multiplier;
            OctoPrint.printer.jog(data);
        };


        self.sendHomeCommand = function (axis) {
            OctoPrint.printer.home(axis);
        };

        self.sendFeedRateCommand = function () {
            OctoPrint.printer.setFeedrate(self.feedRate());
        };

        self.sendExtrudeCommand = function () {
            self._sendECommand(1);
        };

        self.sendRetractCommand = function () {
            self._sendECommand(-1);
        };

        self.sendFlowRateCommand = function () {
            OctoPrint.printer.setFlowrate(self.flowRate());
        };

        self._sendECommand = function (dir) {
            var length = self.extrusionAmount() || self.settings.printer_defaultExtrusionLength();
            OctoPrint.printer.extrude(length * dir);
        };

        self.sendSelectToolCommand = function (data) {
            if (!data || !data.key()) return;

            OctoPrint.printer.selectTool(data.key());
        };


        self.sendCustomCommand = function (command) {
            if (!command) return;

            var parameters = {};
            if (command.hasOwnProperty("input")) {
                _.each(command.input, function (input) {
                    if (!input.hasOwnProperty("parameter") || !input.hasOwnProperty("value")) {
                        return;
                    }

                    parameters[input.parameter] = input.value();
                });
            }

            if (command.hasOwnProperty("command") || command.hasOwnProperty("commands")) {
                var commands = command.commands || [command.command];
                OctoPrint.control.sendGcodeWithParameters(commands, parameters);
            } else if (command.hasOwnProperty("script")) {
                var script = command.script;
                var context = command.context || {};
                OctoPrint.control.sendGcodeScriptWithParameters(script, context, parameters);
            }
        };


        self.displayMode = function (customControl) {
            if (customControl.hasOwnProperty("children")) {
                if (customControl.name) {
                    return "customControls_containerTemplate_collapsable";
                } else {
                    return "customControls_containerTemplate_nameless";
                }
            } else {
                return "customControls_controlTemplate";
            }
        };

        self.rowCss = function (customControl) {
            var span = "span2";
            var offset = "";
            if (customControl.hasOwnProperty("width")) {
                span = "span" + customControl.width;
            }
            if (customControl.hasOwnProperty("offset")) {
                offset = "offset" + customControl.offset;
            }
            return span + " " + offset;
        };


        self.onStartup = function() {
            self.requestData();
            var graph = $("#temperature-graph");
            if (graph.length && !OctoPrint.coreui.browser.mobile) {
                graph.bind("plothover",  function (event, pos, item) {
                    self.plotHoverPos = pos;
                    if (!self.plotLegendTimeout) {
                        self.plotLegendTimeout = window.setTimeout(function() {
                            self.updateLegend(self._replaceLegendLabel)
                        }, 50);
                    }
                });
            }

            self.changeOffsetDialog = $("#change_offset_dialog");
        };



        self.onStartupComplete = function() {
            self.initOrUpdate();
            self._printerProfileUpdated();
        };

        self.onUserLoggedIn = self.onUserLoggedOut = function() {
            self.initOrUpdate();
        };
        self._disableWebcam = function() {
            // only disable webcam stream if tab is out of focus for more than 5s, otherwise we might cause
            // more load by the constant connection creation than by the actual webcam stream

            // safari bug doesn't release the mjpeg stream, so we just disable this for safari.
            if (OctoPrint.coreui.browser.safari) {
                return;
            }

            var timeout = self.settings.webcam_streamTimeout() || 5;
            self.webcamDisableTimeout = setTimeout(function () {
                log.debug("Unloading webcam stream");
                $("#webcam_image").attr("src", "");
                self.webcamLoaded(false);
            }, timeout * 1000);
        };

        self._enableWebcam = function() {
            if (OctoPrint.coreui.selectedTab != "#control" || !OctoPrint.coreui.browserTabVisible) {
                return;
            }

            if (self.webcamDisableTimeout != undefined) {
                clearTimeout(self.webcamDisableTimeout);
            }
            var webcamImage = $("#webcam_image");
            var currentSrc = webcamImage.attr("src");

            // safari bug doesn't release the mjpeg stream, so we just set it up the once
            if (OctoPrint.coreui.browser.safari && currentSrc != undefined) {
                return;
            }

            var newSrc = self.settings.webcam_streamUrl();
            if (currentSrc != newSrc) {
                if (newSrc.lastIndexOf("?") > -1) {
                    newSrc += "&";
                } else {
                    newSrc += "?";
                }
                newSrc += new Date().getTime();

                self.webcamLoaded(false);
                self.webcamError(false);
                webcamImage.attr("src", newSrc);
            }
        };

        self.onWebcamLoaded = function() {
            if (self.webcamLoaded()) return;

            log.debug("Webcam stream loaded");
            self.webcamLoaded(true);
            self.webcamError(false);
        };

        self.onWebcamErrored = function() {
            log.debug("Webcam stream failed to load/disabled");
            self.webcamLoaded(false);
            self.webcamError(true);
        };

        self.onTabChange = function (current, previous) {
            if (current == "#control") {
                self._enableWebcam();
            } else if (previous == "#control") {
                self._disableWebcam();
            }
        };

        self.onBrowserTabVisibilityChange = function(status) {
            if (status) {
                self._enableWebcam();
            } else {
                self._disableWebcam();
            }
            self.updateOutput();
        };

        self.onAllBound = function (allViewModels) {
            var additionalControls = [];
            callViewModels(allViewModels, "getAdditionalControls", function(method) {
                additionalControls = additionalControls.concat(method());
            });
            if (additionalControls.length > 0) {
                self.additionalControls = additionalControls;
                self.rerenderControls();
            }
            self._enableWebcam();
        };

        self.onFocus = function (data, event) {
            if (!self.settings.feature_keyboardControl()) return;
            self.keycontrolActive(true);
        };

        self.onMouseOver = function (data, event) {
            if (!self.settings.feature_keyboardControl()) return;
            $("#webcam_container").focus();
            self.keycontrolActive(true);
        };

        self.onMouseOut = function (data, event) {
            if (!self.settings.feature_keyboardControl()) return;
            $("#webcam_container").blur();
            self.keycontrolActive(false);
        };


        self.toggleKeycontrolHelp = function () {
            self.keycontrolHelpActive(!self.keycontrolHelpActive());
        };

        self.onKeyDown = function (data, event) {
            if (!self.settings.feature_keyboardControl()) return;

            var button = undefined;
            var visualizeClick = true;

            switch (event.which) {
                case 37: // left arrow key
                    // X-
                    button = $("#control-xdec");
                    break;
                case 38: // up arrow key
                    // Y+
                    button = $("#control-yinc");
                    break;
                case 39: // right arrow key
                    // X+
                    button = $("#control-xinc");
                    break;
                case 40: // down arrow key
                    // Y-
                    button = $("#control-ydec");
                    break;
                case 49: // number 1
                case 97: // numpad 1
                    // Distance 0.1
                    button = $("#control-distance01");
                    visualizeClick = false;
                    break;
                case 50: // number 2
                case 98: // numpad 2
                    // Distance 1
                    button = $("#control-distance1");
                    visualizeClick = false;
                    break;
                case 51: // number 3
                case 99: // numpad 3
                    // Distance 10
                    button = $("#control-distance10");
                    visualizeClick = false;
                    break;
                case 52: // number 4
                case 100: // numpad 4
                    // Distance 100
                    button = $("#control-distance100");
                    visualizeClick = false;
                    break;
                case 33: // page up key
                case 87: // w key
                    // z lift up
                    button = $("#control-zinc");
                    break;
                case 34: // page down key
                case 83: // s key
                    // z lift down
                    button = $("#control-zdec");
                    break;
                case 36: // home key
                    // xy home
                    button = $("#control-xyhome");
                    break;
                case 35: // end key
                    // z home
                    button = $("#control-zhome");
                    break;
                default:
                    event.preventDefault();
                    return false;
            }

            if (button === undefined) {
                return false;
            } else {
                event.preventDefault();
                if (visualizeClick) {
                    button.addClass("active");
                    setTimeout(function () {
                        button.removeClass("active");
                    }, 150);
                }
                button.click();
            }
        };

        self.stripDistanceDecimal = function(distance) {
            return distance.toString().replace(".", "");
        };
        self.temperatures = [];

        self.plot = undefined;
        self.plotHoverPos = undefined;
        self.plotLegendTimeout = undefined;
        self._getPlotInfo = function() {
            var data = [];
            var heaterOptions = self.heaterOptions();
            if (!heaterOptions) return undefined;

            var maxTemps = [310/1.1];
            var now = Date.now();

            var showFahrenheit = self._shallShowFahrenheit();

            _.each(_.keys(heaterOptions), function(type) {
                if (type === "bed" && !self.hasBed()) {
                    return;
                }

                var actuals = [];
                var targets = [];

                if (self.temperatures[type]) {
                    actuals = self.temperatures[type].actual;
                    targets = self.temperatures[type].target;
                }

                var actualTemp = actuals && actuals.length ? formatTemperature(actuals[actuals.length - 1][1], showFahrenheit) : "-";
                var targetTemp = targets && targets.length ? formatTemperature(targets[targets.length - 1][1], showFahrenheit, 1) : "-";

                data.push({
                    label: gettext("Actual") + " " + heaterOptions[type].name + ": " + actualTemp,
                    color: heaterOptions[type].color,
                    data: actuals.length ? actuals : [[now, undefined]]
                });
                data.push({
                    label: gettext("Target") + " " + heaterOptions[type].name + ": " + targetTemp,
                    color: pusher.color(heaterOptions[type].color).tint(0.5).html(),
                    data: targets.length ? targets : [[now, undefined]]
                });

                maxTemps.push(self.getMaxTemp(actuals, targets));
            });

            return {max: maxTemps, data: data};
        };

        self.updateLegend = function(replaceLegendLabel) {
            self.plotLegendTimeout = undefined;

            var resetLegend = function() {
                _.each(dataset, function(series, index) {
                    var value = series.data && series.data.length ? series.data[series.data.length - 1][1] : undefined;
                    replaceLegendLabel(index, series, value);
                });
            };

            var pos = self.plotHoverPos;
            if (pos && !OctoPrint.coreui.browser.mobile) {
                // we got a hover position, let's see what we need to do with that

                var i;
                var axes = self.plot.getAxes();
                var dataset = self.plot.getData();

                if (pos.x < axes.xaxis.min || pos.x > axes.xaxis.max ||
                    pos.y < axes.yaxis.min || pos.y > axes.yaxis.max) {
                    // position outside of the graph, show latest temperature in legend
                    resetLegend();
                } else {
                    // position inside the graph, determine temperature at point and display that in the legend
                    _.each(dataset, function(series, index) {
                        for (i = 0; i < series.data.length; i++) {
                            if (series.data[i][0] > pos.x) {
                                break;
                            }
                        }

                        var y;
                        var p1 = series.data[i - 1];
                        var p2 = series.data[i];

                        if (p1 === undefined && p2 === undefined) {
                            y = undefined;
                        } else if (p1 === undefined) {
                            y = p2[1];
                        } else if (p2 === undefined) {
                            y = p1[1];
                        } else {
                            y = p1[1] + (p2[1] - p1[1]) * (pos.x - p1[0]) / (p2[0] - p1[0]);
                        }

                        replaceLegendLabel(index, series, y, true);
                    });
                }
            } else {
                resetLegend();
            }

            // update the grid
            self.plot.setupGrid();
        };


        self.getMaxTemp = function(actuals, targets) {
            var maxTemp = 0;
            actuals.forEach(function(pair) {
                if (pair[1] > maxTemp){
                    maxTemp = pair[1];
                }
            });
            targets.forEach(function(pair) {
                if (pair[1] > maxTemp){
                    maxTemp = pair[1];
                }
            });
            return maxTemp;
        };

        self.incrementTarget = function(item) {
            var value = item.newTarget();
            if (value === undefined || (typeof(value) === "string" && value.trim() === "")) {
                value = item.target();
            }
            try {
                value = parseInt(value);
                if (value > 999) return;
                item.newTarget(value + 1);
                self.autosendTarget(item);
            } catch (ex) {
                // do nothing
            }
        };

        self.decrementTarget = function(item) {
            var value = item.newTarget();
            if (value === undefined || (typeof(value) === "string" && value.trim() === "")) {
                value = item.target();
            }
            try {
                value = parseInt(value);
                if (value <= 0) return;
                item.newTarget(value - 1);
                self.autosendTarget(item);
            } catch (ex) {
                // do nothing
            }
        };

        var _sendTimeout = {};

        self.autosendTarget = function(item) {
            if (!self.settings.temperature_sendAutomatically()) return;
            var delay = self.settings.temperature_sendAutomaticallyAfter() * 1000;

            var name = item.name();
            if (_sendTimeout[name]) {
                window.clearTimeout(_sendTimeout[name]);
            }
            _sendTimeout[name] = window.setTimeout(function() {
                self.setTarget(item);
                delete _sendTimeout[name];
            }, delay);
        };

        self.clearAutosendTarget = function(item) {
            var name = item.name();
            if (_sendTimeout[name]) {
                window.clearTimeout(_sendTimeout[name]);
                delete _sendTimeout[name];
            }
        };

        self.setTarget = function(item, form) {
            var value = item.newTarget();
            if (form !== undefined) {
                $(form).find("input").blur();
            }
            if (value === undefined || (typeof(value) === "string" && value.trim() === "")) return OctoPrintClient.createRejectedDeferred();

            self.clearAutosendTarget(item);
            return self.setTargetToValue(item, value);
        };

        self.setTargetFromProfile = function(item, profile) {
            if (!profile) return OctoPrintClient.createRejectedDeferred();

            self.clearAutosendTarget(item);

            var target;
            if (item.key() === "bed") {
                target = profile.bed;
            } else if (item.key() === "chamber") {
                target = profile.chamber;
            } else {
                target = profile.extruder;
            }

            if (target === undefined) target = 0;
            return self.setTargetToValue(item, target);
        };

        self.setTargetToZero = function(item) {
            self.clearAutosendTarget(item);
            return self.setTargetToValue(item, 0);
        };

        self.setTargetToValue = function(item, value) {
            self.clearAutosendTarget(item);

            try {
                value = parseInt(value);
            } catch (ex) {
                return OctoPrintClient.createRejectedDeferred();
            }

            if (value < 0 || value > 999) return OctoPrintClient.createRejectedDeferred();

            var onSuccess = function() {
                item.target(value);
                item.newTarget("");
            };

            if (item.key() === "bed") {
                return self._setBedTemperature(value)
                    .done(onSuccess);
            } else if (item.key() === "chamber") {
                return self._setChamberTemperature(value)
                    .done(onSuccess);
            } else {
                return self._setToolTemperature(item.key(), value)
                    .done(onSuccess);
            }
        };

        self.changeOffset = function(item) {
            // copy values
            self.changingOffset.item = item;
            self.changingOffset.name(item.name());
            self.changingOffset.offset(item.offset());
            self.changingOffset.newOffset(item.offset());

            self.changeOffsetDialog.modal("show");
        };

        self.incrementChangeOffset = function() {
            var value = self.changingOffset.newOffset();
            if (value === undefined || (typeof(value) === "string" && value.trim() === "")) value = self.changingOffset.offset();
            try {
                value = parseInt(value);
                if (value >= 50) return;
                self.changingOffset.newOffset(value + 1);
            } catch (ex) {
                // do nothing
            }
        };

        self.decrementChangeOffset = function() {
            var value = self.changingOffset.newOffset();
            if (value === undefined || (typeof(value) === "string" && value.trim() === "")) value = self.changingOffset.offset();
            try {
                value = parseInt(value);
                if (value <= -50) return;
                self.changingOffset.newOffset(value - 1);
            } catch (ex) {
                // do nothing
            }
        };


        self.deleteChangeOffset = function() {
            self.changingOffset.newOffset(0);
        };

        self.confirmChangeOffset = function() {
            var item = self.changingOffset.item;
            item.newOffset(self.changingOffset.newOffset());

            self.setOffset(item)
                .done(function() {
                    self.changeOffsetDialog.modal("hide");

                    // reset
                    self.changingOffset.offset(0);
                    self.changingOffset.newOffset(0);
                    self.changingOffset.name("");
                    self.changingOffset.item = undefined;
                })
        };

        self.setOffset = function(item) {
            var value = item.newOffset();
            if (value === undefined || (typeof(value) === "string" && value.trim() === "")) return OctoPrintClient.createRejectedDeferred();
            return self.setOffsetToValue(item, value);
        };

        self.setOffsetToZero = function(item) {
            return self.setOffsetToValue(item, 0);
        };

        self.setOffsetToValue = function(item, value) {
            try {
                value = parseInt(value);
            } catch (ex) {
                return OctoPrintClient.createRejectedDeferred();
            }

            if (value < -50 || value > 50) return OctoPrintClient.createRejectedDeferred();

            var onSuccess = function() {
                item.offset(value);
                item.newOffset("");
            };

            if (item.key() === "bed") {
                return self._setBedOffset(value)
                    .done(onSuccess);
            } else if (item.key() === "chamber") {
                return self._setChamberOffset(value)
                    .done(onSuccess);
            } else {
                return self._setToolOffset(item.key(), value)
                    .done(onSuccess);
            }
        };

        self._setToolTemperature = function(tool, temperature) {
            var data = {};
            data[tool] = parseInt(temperature);
            return OctoPrint.printer.setToolTargetTemperatures(data);
        };

        self._setToolOffset = function(tool, offset) {
            var data = {};
            data[tool] = parseInt(offset);
            return OctoPrint.printer.setToolTemperatureOffsets(data);
        };

        self._setBedTemperature = function(temperature) {
            return OctoPrint.printer.setBedTargetTemperature(parseInt(temperature));
        };

        self._setBedOffset = function(offset) {
            return OctoPrint.printer.setBedTemperatureOffset(parseInt(offset));
        };

        self._setChamberTemperature = function(temperature) {
            return OctoPrint.printer.setChamberTargetTemperature(parseInt(temperature));
        };

        self._setChamberOffset = function(offset) {
            return OctoPrint.printer.setChamberTemperatureOffset(parseInt(offset));
        };

        self._replaceLegendLabel = function(index, series, value, emph) {
            var showFahrenheit = self._shallShowFahrenheit();

            var temp;
            if (index % 2 === 0) {
                // actual series
                temp = formatTemperature(value, showFahrenheit);
            } else {
                // target series
                temp = formatTemperature(value, showFahrenheit, 1);
            }
            if (emph) {
                temp = "<em>" + temp + "</em>";
            }
            series.label = series.label.replace(/:.*/, ": " + temp);
        };

        self._shallShowFahrenheit = function() {
            return (self.settings.settings !== undefined )
                   ? self.settings.settings.appearance.showFahrenheitAlso()
                   : false;
        };

        self.handleEnter = function(event, type, item) {
            if (event.keyCode === 13) {
                if (type === "target") {
                    self.setTarget(item)
                        .done(function() {
                            event.target.blur();
                        });
                } else if (type === "offset") {
                    self.confirmChangeOffset();
                }
            }
        };


        self.handleFocus = function(event, type, item) {
            if (type === "target") {
                var value = item.newTarget();
                if (value === undefined || (typeof(value) === "string" && value.trim() === "")) {
                    item.newTarget(item.target());
                }
                window.setTimeout(function() {
                    event.target.select();
                }, 0);
            } else if (type === "offset") {
                window.setTimeout(function() {
                    event.target.select();
                }, 0);
            }
        };

        self.initOrUpdate = function() {
            if (OctoPrint.coreui.selectedTab !== "#control" || !$("#control").is(":visible")) {
                // do not try to initialize the graph when it's not visible or its sizing will be off
                return;
            }

            if (!self.plot) {
                self._initializePlot();
            } else {
                self.updatePlot();
            }
        };

        self.onAfterTabChange = function() {
            self.initOrUpdate();
            self.updateOutput();

        };

        self.onAfterTabChange = function(current, previous) {
            self.tabActive = current == "#control";
            self.updateOutput();
        };
        self.AvanceVisible = ko.observable(false);
        self.AvanceVisibility=  function(){
             self.AvanceVisible(!self.AvanceVisible());
         }
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: ControlViewModel,
        dependencies: ["loginStateViewModel", "settingsViewModel"],
        elements: ["#control"]
    });
});
