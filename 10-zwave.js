/*

 OpenZWave nodes for IBM's Node-Red
 https://github.com/ekarak/node-red-contrib-openzwave
 (c) 2014-2017, Elias Karakoulakis <elias.karakoulakis@gmail.com>
 (c) 2017 Sebastian Barwe <sebastian.barwe@gmail.com>
 
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at

 http://www.apache.org/licenses/LICENSE-2.0

 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.

 */


var UUIDPREFIX = "_macaddr_";
var HOMENAME = "_homename_";
require('getmac').getMac(function (err, macAddress) {
    if (err) throw err;
    UUIDPREFIX = macAddress.replace(/:/gi, '');
});


module.exports = function (RED) {
    const serialp = require("serialport");
	const util = require('util');
	const path = require('path');
	const fs = require('fs');
	
	var ozwsharedpath = path.dirname(path.dirname(require.resolve('openzwave-shared')));
	var ozwsharedpackage = JSON.parse(fs.readFileSync(ozwsharedpath+"/package.json"));
	var thispackage = JSON.parse(fs.readFileSync(__dirname+'/package.json'));
	RED.log.info('openzwave-shared: ' + ozwsharedpackage.version);
	RED.log.info('node-red-contrib-openzwave: ' + thispackage.version);
	
    const OpenZWave = require('openzwave-shared');

    var ozwConfig = {};
    var ozwDriver = null;
    var ozwConnected = false;
    var driverReadyStatus = false;
	var allowunreadyupdates = false;
	
    // array of all zwave nodes with internal hashmaps for their properties and their values
    var zwnodes = {};
    // Provide context.global access to node info.
    RED.settings.functionGlobalContext.openzwaveNodes = zwnodes;
    RED.settings.functionGlobalContext.openzwaveNetwork = ozwConfig;
    // event routing map: which NR node gets notified for each zwave event
    var nrNodeSubscriptions = {}; // {'event1' => {node1: closure1, node2: closure2...}, 'event2' => ...}

    /* ============================================================================
     * ZWSUBSCRIBE: subscribe a Node-Red node to OpenZWave events
     * ============================================================================
     **/
    function zwsubscribe(nrNode, event, callback) {
        if (!(event in nrNodeSubscriptions))
            nrNodeSubscriptions[event] = {};
        RED.log.trace(util.format('subscribing %s(%s) to event %s', nrNode.type, nrNode.id, event));
        nrNodeSubscriptions[event][nrNode.id] = callback;
    }

    // and unsubscribe
    function zwunsubscribe(nrNode) {
        for (var event in nrNodeSubscriptions) {
            if (nrNodeSubscriptions.hasOwnProperty(event)) {
                RED.log.trace(util.format('unsubscribing %s(%s) from %s', nrNode.type, nrNode.id, event));
                delete nrNodeSubscriptions[event][nrNode.id];
            }
        }
    }

    /* ============================================================================
     * ZWCALLBACK: dispatch OpenZwave events onto all active Node-Red subscriptions
     * ============================================================================
     **/
    function zwcallback(event, arghash) {
        RED.log.trace(util.format("zwcallback(event: %s, args: %j)", event, arghash));
        // Add uuid
        if (arghash.nodeid !== undefined && HOMENAME !== undefined)
            arghash.uuid = UUIDPREFIX + '-' +
                HOMENAME + '-' +
                arghash.nodeid;

        if (nrNodeSubscriptions.hasOwnProperty(event)) {
            var nrNodes = nrNodeSubscriptions[event];
            // an event might be subscribed by multiple NR nodes
            for (var nrnid in nrNodes) {
                if (nrNodes.hasOwnProperty(nrnid)) {
                    var nrNode = RED.nodes.getNode(nrnid);
                    RED.log.trace(util.format("zwcallback => %j,  %s,  args %j", nrNode, event, arghash));
                    nrNodes[nrnid].call(nrNode, event, arghash);
                    updateNodeRedStatus(nrNode);
                }
            }
        }
    }

    // update the NR node's status indicator
    function updateNodeRedStatus(nrNode, options) {
        // update NR node status
        nrNode.status(options || {
            fill: driverReadyStatus ? "green" : "red",
            text: driverReadyStatus ? "connected" : "disconnected",
            shape: "ring"
        });
    }

    function driverReady(homeid) {
        driverReadyStatus = true;
        ozwConfig.homeid = homeid;
        var homeHex = '0x' + homeid.toString(16);
        HOMENAME = homeHex;
        ozwConfig.name = homeHex;
        RED.log.info(util.format('scanning Zwave network with homeid %s...', homeHex));
        zwcallback('driver ready', ozwConfig);
    }

    function driverFailed() {
        zwcallback('driver failed', ozwConfig);
        process.exit();
    }

    function nodeAdded(nodeid) {
        zwnodes[nodeid] = {
            manufacturer: '', manufacturerid: '',
            product: '', producttype: '', productid: '',
            type: '', name: '', loc: '',
            classes: {},
            ready: false,
            available: false,
            alive: false,
        };
        zwcallback('node added', {"nodeid": nodeid});
    }

    function nodeAlive(nodeid) {
        zwnodes[nodeid].alive = true;
        zwcallback('node alive', {"nodeid": nodeid});
    }

    function nodeDead(nodeid) {
        zwnodes[nodeid].alive = false;
        zwcallback('node dead', {"nodeid": nodeid});
    }

    function valueAdded(nodeid, comclass, valueId) {
        if (!zwnodes[nodeid]['classes'][comclass])
            zwnodes[nodeid]['classes'][comclass] = {};
        if (!zwnodes[nodeid]['classes'][comclass][valueId.instance])
            zwnodes[nodeid]['classes'][comclass][valueId.instance] = {};
        // add to cache
        zwnodes[nodeid]['classes'][comclass][valueId.instance][valueId.index] = valueId;
        // tell NR
        zwcallback('value added', {
            "nodeid": nodeid, "cmdclass": comclass, "instance": valueId.instance, "cmdidx": valueId.index,
            "currState": valueId['value'],
            "label": valueId['label'],
            "units": valueId['units'],
            "value": valueId
        });
    }

    function valueChanged(nodeid, comclass, valueId) {
        // valueId: OpenZWave ValueID (struct) - not just a boolean
        var oldst;
        if (zwnodes[nodeid].ready || allowunreadyupdates) {
            oldst = zwnodes[nodeid]['classes'][comclass][valueId.instance][valueId.index].value;
            RED.log.trace(util.format('node%d: changed: %d:%s:%s->%s', nodeid, comclass, valueId['label'], oldst, valueId['value']));
            RED.log.trace(util.format('node%d: value=%s', nodeid, JSON.stringify(valueId)));
            
            // tell NR only if the node is marked as ready
            zwcallback('value changed', {
                "nodeid": nodeid, "cmdclass": comclass, "instance": valueId.instance, "cmdidx": valueId.index,
                "oldState": oldst, "currState": valueId['value'],
                "label": valueId['label'],
                "units": valueId['units'],
                "value": valueId
            });
        }
        // update cache
        zwnodes[nodeid]['classes'][comclass][valueId.instance][valueId.index] = valueId;
    }

    function valueRemoved(nodeid, comclass, instance, index) {
        if (zwnodes[nodeid] &&
            zwnodes[nodeid]['classes'] &&
            zwnodes[nodeid]['classes'][comclass] &&
            zwnodes[nodeid]['classes'][comclass][index]) {
            delete zwnodes[nodeid]['classes'][comclass][index];

            if (Object.keys(zwnodes[nodeid]['classes'][comclass]).length === 0)
                delete zwnodes[nodeid]['classes'][comclass];
            if (Object.keys(zwnodes[nodeid]['classes']).length === 0)
                delete zwnodes[nodeid];
            if (comclass === 134)
                delete zwnodes[nodeid];

            zwcallback('value deleted', {
                "nodeid": nodeid, "cmdclass": comclass, "cmdidx": index, "instance": instance
            });
        }
    }

    function nodeReady(nodeid, nodeinfo) {
        for (var attrname in nodeinfo) {
            if (nodeinfo.hasOwnProperty(attrname)) {
                zwnodes[nodeid][attrname] = nodeinfo[attrname];
            }
        }
		RED.log.info(util.format("node%d: node ready (%s %s)", nodeid, nodeinfo.manufacturer || "", nodeinfo.product || ""));
        zwnodes[nodeid].ready = true;
        //
        for (var comclass in zwnodes[nodeid]['classes']) {
            switch (comclass) {
                case 0x25: // COMMAND_CLASS_SWITCH_BINARY
                case 0x26: // COMMAND_CLASS_SWITCH_MULTILEVEL
                case 0x30: // COMMAND_CLASS_SENSOR_BINARY
                case 0x31: // COMMAND_CLASS_SENSOR_MULTILEVEL
                case 0x60: // COMMAND_CLASS_MULTI_INSTANCE
                    ozwDriver.enablePoll(nodeid, comclass);
                    break;
            }

            var values = zwnodes[nodeid]['classes'][comclass];
            RED.log.trace(util.format('node%d: class %d', nodeid, comclass));
            for (var idx in values)
                RED.log.trace(util.format('node%d:   %s=%s', nodeid, values[idx]['label'], values[idx]['value']));
            
        }
        //
        zwcallback('node ready', {nodeid: nodeid, nodeinfo: nodeinfo});
    }

    function nodeAvailable(nodeid, nodeinfo) {
        for (var attrname in nodeinfo) {
            if (nodeinfo.hasOwnProperty(attrname)) {
                zwnodes[nodeid][attrname] = nodeinfo[attrname];
            }
        }
        zwnodes[nodeid].available = true;
        zwcallback('node available', {nodeid: nodeid, nodeinfo: nodeinfo});
    }

    function nodeEvent(nodeid, evt, help) {
		RED.log.trace(util.format('node%d: %s', nodeid, help));
        zwcallback('node event', {
            "nodeid": nodeid, 
			"event": evt, 
			"help": help            
        });
    }

    function notification(nodeid, notif, help) {
        RED.log.trace(util.format('node%d: %s', nodeid, help));
        zwcallback('notification', {nodeid: nodeid, notification: notif, help: help});
    }

    function scanComplete() {
        RED.log.info('ZWave network scan complete.');
        zwcallback('scan complete', {});
    }

    function controllerCommand(nodeid, state, errcode, help) {
        RED.log.trace('ZWave controller command feedback received');
        zwcallback('controller command', {nodeid: nodeid, state: state, errcode: errcode, help: help});
    }
	
	function sceneEvent(nodeid, sceneid) {
		RED.log.trace(util.format('node%d: scende event %d', nodeid, sceneid));
		zwcallback('scene event', {
			"nodeid": nodeid, "sceneid": sceneid});
 	}

    // list of events emitted by OpenZWave and redirected to Node flows by the mapped function
    var ozwEvents = {
        'driver ready': driverReady,
        'driver failed': driverFailed,
        'node added': nodeAdded,
        'node alive': nodeAlive,
        'node dead': nodeDead,
        'node available': nodeAvailable,
        'node ready': nodeReady,
        'node event': nodeEvent,
        'value added': valueAdded,
        'value changed': valueChanged,
        'value removed': valueRemoved,
        'notification': notification,
        'scan complete': scanComplete,
        'controller command': controllerCommand,
		'scene event': sceneEvent
    }

    // ==========================
    function ZWaveController(config) {
    // ==========================
        RED.nodes.createNode(this, config);
        this.name = config.port;
        this.port = config.port;
        this.driverattempts = config.driverattempts || 3;
        this.pollinterval = config.pollinterval || 10000;
		this.allowunreadyupdates = config.allowunreadyupdates;
		this.logging = config.logging || 0;
        var node = this;

        // initialize OpenZWave upon boot or fetch it from the global reference
        // (used across Node-Red deployments which recreate all the nodes)
        // so we only get to initialise one single OZW driver (a lengthy process)
		// see options.xml in the node's directory for basic options.
		// these options are overrided by the following initialization options
		// see https://github.com/OpenZWave/open-zwave/wiki/Config-Options for a description of the available parmeters.
        if (!ozwDriver) {
            ozwDriver = new OpenZWave({
				UserPath: RED.settings.userDir,		// save ozw data in nodered user dir
				//ConfigPath: RED.settings.userDir,	 // path must containt the zwave configuration library from ozw
				LogFileName: "ozw.log",				// TODO: append homeid to filename 
				Interface: node.port,				// the serial port to use
	            Logging: true,  					// enable logging to OZW_Log.txt
                ConsoleOutput: true, 				// copy logging to the console
				SaveConfig: false,      				// write an XML network layout
				SaveConfiguration: true,
				DriverAttempts: node.driverattempts,// try this many times before giving up
				PollInterval: node.pollinterval,    // interval between polls in milliseconds
				SuppressRefresh: false,    			// use refreshes to update alive timestamp
	            QueueLogLevel: node.logging,
				NotifyTransactions: true,			// Notifications when transaction complete is reported.
				
				//NetworkKey: "0xd2,0x58,0x85,0x11,0xa2,0x50,0xbc,0xd9,0xf4,0xa5,0x85,0x48,0x3f,0x9f,0xf8,0x06"
            });
				
			/* =============== OpenZWave events ================== */
			Object.keys(ozwEvents).forEach(function (evt) {
				RED.log.trace(node.name + ' addListener ' + evt);
				ozwDriver.on(evt, ozwEvents[evt]);
			});
        }



        /* =============== Node-Red events ================== */
        this.on("close", function () {
            RED.log.trace('zwave-controller: close');
            // controller should also unbind from the C++ addon
            if (ozwDriver) {
                ozwDriver.removeAllListeners()
                //disablePoll
                for (nodeid in zwnodes)
                    for (comclass in zwnodes[nodeid]['classes']) {
                        switch (comclass) {
                            case 0x25: // COMMAND_CLASS_SWITCH_BINARY
                            case 0x26: // COMMAND_CLASS_SWITCH_MULTILEVEL
                            case 0x30: // COMMAND_CLASS_SENSOR_BINARY
                            case 0x31: // COMMAND_CLASS_SENSOR_MULTILEVEL
                            case 0x60: // COMMAND_CLASS_MULTI_INSTANCE
                                ozwDriver.disablePoll(nodeid, comclass);
                                break;
                        }
                    }
            }

        });

		zwsubscribe(node, 'scan complete', function(event, data) {
 			ozwDriver.setPollInterval(node.pollinterval);
 			allowunreadyupdates = node.allowunreadyupdates;
 		});
 
        zwsubscribe(node, 'driver failed', function (event, data) {
            RED.log.error(util.format('failed to start ZWave driver, is there a ZWave stick attached to %s ?', node.port));
        });

        /* time to connect */
        if (!ozwConnected) {
            RED.log.trace(util.format('ZWave Driver: connecting to %s', config.port));
            ozwDriver.connect(config.port);
            ozwConnected = true;
			
			function exitHandler(options, err) {
				if (ozwDriver && ozwConnected) {
					RED.log.info('disconnecting ZWave driver on '+node.port);
					ozwDriver.disconnect(node.port);
				}
			
				if (options.cleanup) RED.log.trace('clean shutdown');
				if (err) RED.log.trace(util.format("%j", err.stack));
			}
			//do something when app is closing
			process.on('exit', exitHandler.bind(null,{cleanup:true}));
        }
		
		
	}

    //
    RED.nodes.registerType("zwave-controller", ZWaveController);
    //

    // =========================
    function ZWaveIn(config) {
        // =========================
        RED.nodes.createNode(this, config);
        this.name = config.name;
        //
        var node = this;
        var zwaveController = RED.nodes.getNode(config.controller);

        if (!zwaveController) {
            node.error('no ZWave controller class defined!');
            return;
        }
        /* =============== Node-Red events ================== */
        this.on("close", function () {
            // set zwave node status as disconnected
            node.status({fill: "red", shape: "ring", text: "disconnected"});
            // remove all event subscriptions for this node
            zwunsubscribe(this);
            node.info('zwave-in: close');
        });
        this.on("error", function () {
            // what? there are no errors. there never were.
            node.status({fill: "yellow", shape: "ring", text: "error"});
        });

        /* =============== OpenZWave events ================== */
        Object.keys(ozwEvents).forEach(function (key) {
            zwsubscribe(node, key, function (event, data) {
                var msg = {'topic': 'zwave: ' + event};
                if (data) msg.payload = data;
                RED.log.trace(util.format('===> ZWAVE-IN injecting: %j', msg));
                node.send(msg);
            });
        });
        // set initial node status upon creation
        updateNodeRedStatus(node);
    }

    //
    RED.nodes.registerType("zwave-in", ZWaveIn);
    //

    // =========================
    function ZWaveOut(config) {
        // =========================
        RED.nodes.createNode(this, config);
        this.name = config.name;
		this.topic = config.topic || null;
		
        //
        var node = this;
        var zwaveController = RED.nodes.getNode(config.controller);

        if (!zwaveController) {
            node.error('no ZWave controller class defined!');
            return;
        }

        /* =============== Node-Red events ================== */
        //
        this.on("input", function (msg) {
            RED.log.trace(util.format("ZWaveOut#input: %j", msg));
            var payload;
            try {
                payload = (typeof(msg.payload) === "string") ?
                    JSON.parse(msg.payload) : msg.payload;
            } catch (err) {
                node.error(node.name + ': illegal msg.payload! (' + err + ')');
                return;
            }
            switch (true) {

                // switch On/Off: for basic single-instance switches and dimmers
                case /switchOn/.test(msg.topic):
                    ozwDriver.setValue(payload.nodeid, 37, 1, 0, true);
                    break;
                case /switchOff/.test(msg.topic):
                    ozwDriver.setValue(payload.nodeid, 37, 1, 0, false);
                    break;

                // setLevel: for dimmers
                case /setLevel/.test(msg.topic):
                    ozwDriver.setValue(payload.nodeid, 38, 1, 0, payload.value);
                    break;

                // setValue: for everything else
                case /setValue/.test(msg.topic):
                    RED.log.trace(util.format("ZWaveOut.setValue payload: %j", payload));
                    ozwDriver.setValue(
                        payload.nodeid,
                        (payload.cmdclass || 37),// default cmdclass: on-off
                        (payload.instance || 1), // default instance
                        (payload.cmdidx || 0), // default cmd index
                        payload.value
                    );
                    break;

                case /setConfigParam/.test(msg.topic):
                    RED.log.trace(util.format("ZWaveOut.setConfigParam payload: %j", payload));
                    ozwDriver.setConfigParam(
                        payload.nodeid,
                        payload.paramId,
                        payload.paramValue || payload.value || 0
                    );
                    break;
                case /requestConfigParam/.test(msg.topic):
                    RED.log.trace(util.format("ZWaveOut.requestConfigParam payload: %j", payload));
                    ozwDriver.requestConfigParam(
                        payload.nodeid,
                        payload.paramId
                    );
                    break;
                case /requestAllConfigParams/.test(msg.topic):
                    RED.log.trace(util.format("ZWaveOut.requestAllConfigParams payload: %j", payload));
                    ozwDriver.requestAllConfigParams(payload.nodeid);
                    break;
                case /refreshNodeInfo/.test(msg.topic):
                    RED.log.trace(util.format("ZWaveOut.refreshNodeInfo payload: %j", payload));
                    ozwDriver.refreshNodeInfo(payload.nodeid);
                    break;

				/* EXPERIMENTAL: send basically every available command down
				 * to OpenZWave, just name the function in the message topic
				 * and pass in the arguments as "payload.args" as an array:
				 * {"topic": "someOpenZWaveCommand", "payload": {"args": [1, 2, 3]}}
				 * If the command needs the HomeID as the 1st arg, use "payload.prependHomeId"
				 * */
				 //TODO: move this to special zwave-cmd-node code
                default:
				
					var topic;
					if (msg.topic !== undefined && msg.topic !== "") {
						topic = msg.topic;
					} else {
						topic = node.topic;
					}
					if (topic in ozwDriver &&
						typeof ozwDriver[topic] === 'function' &&
						payload
						){
							RED.log.trace(util.format('attempting direct call to OpenZWave API: %s(%s)', topic, payload));
                        try {
                            var args = payload.args || [];
            				if (payload.prependHomeId) 
								args.unshift(ozwConfig.homeid);
							var retval = ozwDriver[topic].apply(ozwDriver, args);

							
 							if ((typeof result != 'undefined') && !retval) {
 								RED.log.trace('Got return value, sending as payload');
 							} else {
 								RED.log.trace('No return value but call successful, sending empty array');
 							}
							//TODO: move below so that error case is handled
							msg.topic = topic;
							msg.payload.args = args;
							msg.payload.result = retval || [];
							//TODO: this is only for the cmdnode
 							node.send(msg);
                        } catch (err) {
                            node.warn('direct OpenZWave call to ' + topic + ' failed: ' + err);
                        }
                    }
                    ;
            }
            ;
        });

        this.on("close", function () {
            // set zwave node status as disconnected
            node.status({fill: "red", shape: "ring", text: "disconnecting"});
            // remove all event subscriptions for this node
            zwunsubscribe(this);
            node.log('zwave-out: close');
        });

        this.on("error", function () {
            node.status({fill: "yellow", shape: "ring", text: "error"});
			node.log('zwave-out: error');
        });

        /* =============== OpenZWave events ================== */
        Object.keys(ozwEvents).forEach(function (key) {
            zwsubscribe(node, key, function (event, data) {
                // nuttin ;) we merely subscribe to have the NR node status update :)
            });
        });

        // set initial node status upon creation
        updateNodeRedStatus(node);
    }



    //
    RED.nodes.registerType("zwave-out", ZWaveOut);
	
	//TODO: create ZWaveCmd instead of ZWaveOut
	RED.nodes.registerType("zwave-cmd", ZWaveOut);
	
    // create API endpoints for configuration node
    RED.httpAdmin.post("/openzwave/:id/:command", RED.auth.needsPermission("openzwave.write"), function (req, res) {
        var node = RED.nodes.getNode(req.params.id);
        try {
            var command = req.params.command ? req.params.command.toString() : null;
            switch (command) {
                case 'add':
                    if (ozwDriver.addNode)
                        ozwDriver.addNode(false);
                    else
                        ozwDriver.beginControllerCommand('AddDevice', false);
                    res.sendStatus(200);
                    break;
                case 'remove_spec_node':
                    res.sendStatus(200);
                    break;
                case 'remove':
                case 'delete':
					ozwDriver.removeNode();
					// ozwDriver.beginControllerCommand('RemoveDevice', true);
                    res.sendStatus(200);
                    break;
                case 'remove_dead':
                case 'delete_failed':
                    ozwDriver.beginControllerCommand('RemoveFailedNode', true);
                    res.sendStatus(200);
                    break;
                case 'cancel':
                    ozwDriver.cancelControllerCommand(true);
					// TODO: handle asynchronisytoy here
					 if (ozwDriver.addNode)
                        ozwDriver.addNode(true);
                    res.sendStatus(200);
                    break;
                case 'list_nodes':
                    res.status(200).json(zwnodes);
                    break;
                case 'get_homeid':
                    res.status(200).json(ozwConfig);
                    break;
                case 'soft_reset':
                    ozwDriver.softReset();
                    res.sendStatus(200);
                    break;
                case 'heal_network':
                    ozwDriver.healNetwork();
                    res.sendStatus(200);
                    break;
                default:
                    res.sendStatus(404);
            }
        } catch (err) {
            res.sendStatus(500);
            RED.log.error(err);
            node.error(RED._("openzwave.failed", {error: err.toString()}));
        }
    });
    RED.httpAdmin.get("/openzwaveports", RED.auth.needsPermission('serial.read'), function (req, res) {
        serialp.list(function (err, ports) {
            res.json(ports);
        });
    });
}
