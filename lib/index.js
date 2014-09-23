/*
 * Copyright (c) 2013, Yahoo! Inc. All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */
var dgram = require('unix-dgram'),
    fs = require('fs'),
    net = require('net'),
    mkdirp = require('mkdirp'),
    spawn = require('child_process').spawn,
    path = require('path'),
    monitor,
    ENOENT = require('constants').ENOENT,
    statuses = { },
    watcher,
    wconfig = { };

function getFormattedDate() {
    return "[" + new Date().toISOString().substring(0, 19).replace('T', ' ') + "] ";
}

var clog = console.log;
var cerrlog = console.error;
console.log = function (msg) {
    clog.call(this, getFormattedDate() + msg);
};
console.error = function (msg) {
    cerrlog.call(this, getFormattedDate() + msg);
};


if (delete process._nm) {
    monitor = require('monitr');
} else {
    process._nm.disableReport();
}

/**
 * Watcher class
 */
function Watcher(opts, healthChangeCallback) {    
    wconfig = opts.config || {};
    var deadProcTime = opts.max_inactive || wconfig.max_inactive || 60,
        monitorTime = opts.monitor || wconfig.monitor || 30,
        _monPath = opts.monPath || wconfig.monPath || (monitor ? monitor.ipcMonitorPath : process._nm.ipcMonitorPath),
        _statusPath = opts.socket_path || wconfig.socket_path || "/tmp/watcher.sock",
        self = this,
        monitorSocket,
        server,
        um,
        wmetric;

    // set timeouts
    self.maxTimeout = parseInt(opts.timeout || wconfig.timeout, 10) || 30000;
    self.maxStartTimeout = parseInt(opts.timeout_start || wconfig.timeout_start, 10) || 30000;
    self.healthChangeCallback = healthChangeCallback;
    self.maxOpenRequests = 0;
    if (self.healthChangeCallback) {
        //if callback is there, call it, so the initial health param is initialized
        self.healthChangeCallback(self);
    }
    if (self.overall_health_is_down === undefined) {
        self.overall_health_is_down = false;
    }

    // open up a unix socket to get process status messages
    monitorSocket = dgram.createSocket('unix_dgram');

    if (opts.metric) {
        wmetric = opts.metric;
    } else {
        wmetric = require('./watcher_metric.js');
    }

    self._monitorSocket = monitorSocket;
    self._metric = wmetric;
    monitorSocket.on('message', function (msg, rinfo) {
        self.onmessage(msg, rinfo, wmetric);
    });
    // unlink the file associated with the datagram socket
    fs.unlink(_monPath, function () {

        // get a directory and set a umask
        var dir = path.dirname(_monPath),
            um = process.umask(0);

        try {
            mkdirp.sync(dir, 511); //0777
        } catch (ex) {
            console.log("ERROR: Failed to create directory for socket " + ex.stack);
        }

        // start listening
        monitorSocket.bind(_monPath);
        setTimeout(function () {
            try {
                fs.chmodSync(_monPath, 511); //0777
            } catch (e) {
                console.log("ERROR: Could not change mod for Socket" + e.stack);
            }
        }, 500);
        process.umask(um);
    });
    // Setup a tcp server
    server = net.createServer(function (socket) {
        // Every time someone connects, tell them hello and then close the
        // connection.
        try {
            // return processes information
            socket.end(JSON.stringify(statuses));
        } catch (e) {
            console.error("Failed to send response");
        }
    });
    // set umask
    um = process.umask(0);

    fs.unlink(_statusPath, function () {

        // start listening
        server.listen(_statusPath, function () {
            try {
                fs.chmodSync(_statusPath, 511); //0777
            } catch (e) {
                console.log("ERROR: Could not change mod for Socket" + e.stack);
            }
            process.umask(um);
        });
    });

    this._server = server;

    // setup intervals for checking status and inactivity
    self.setupIntervals(deadProcTime, monitorTime, wmetric);
}

Watcher.prototype = {
    closeStatusService: function () {
        try {
            this._server.close();
        } catch (e) {
            console.log("Error happened while: " + e.stack + " while closing status server (can be ignored)");
        }
    },
    setupIntervals : function (deadProcTime, monitorTime, wmetric) {
        var self = this;

        // Set interval to check for
        // process which have died already
        this._inactivityInt = setInterval(function () {
            self.checkInactivity(wmetric);
        }, deadProcTime * 1000);
        // Set interval for monitoring
        this._monitorInt = setInterval(function () {
            self.checkStatus(wmetric);
        }, monitorTime * 1000);
    },
    onmessage : function (msg, rinfo, wmetric) {
        // received message from process
        var info,
            changeInHealth = true,
            totalOpenRequests = 0,
            i;
        try {
            info = JSON.parse(msg.toString());
        } catch (e) {
            console.log('ERROR: Got JSON with broken payload');
        }
        if (!info || !info.status || !info.status.pid) {
            return;
        }

        // update timestamp to the one used by watcher
        info.status.wts = Date.now() / 1000;

        // If status contains that PID already
        // Update the last CPU usage through the average between current
        // and previous CPU usage level.
        // Then do the same for event per seconds metric
        if (statuses[info.status.pid]) {

            if (info.status.health_status_timestamp &&
                statuses[info.status.pid].curr.health_status_timestamp &&
                statuses[info.status.pid].curr.health_is_down === info.status.health_is_down) {
                changeInHealth = false;
            }

            statuses[info.status.pid].curr = info.status;
            statuses[info.status.pid].last.cpu =
                (statuses[info.status.pid].curr.cpu +
                statuses[info.status.pid].last.cpu) / 2;

            statuses[info.status.pid].last.events =
                (statuses[info.status.pid].curr.events +
                statuses[info.status.pid].last.events) / 2;

            statuses[info.status.pid].debug = info.status.debug;
            statuses[info.status.pid].oreqs = info.status.oreqs || 0;

            // If process has not been registered yet
            // Regiter it in the statuses struct under its PID.
        } else {
            // create new entry
            statuses[info.status.pid] = { };
            statuses[info.status.pid].last = info.status;
            statuses[info.status.pid].kill = false;
            statuses[info.status.pid].curr = info.status;
            statuses[info.status.pid].debug = 0;
            statuses[info.status.pid].oreqs = info.status.oreqs || 0;            
        }

        // if process has started listening we will change timeout for processing
        if (info.status.reqstotal > 0) {
            statuses[info.status.pid].listen = true;
        }

        // update the CPU per request metric
        if (info.status.cpuperreq !== undefined) {
            wmetric.set({"watcher.proc.cpureq" : info.status.cpuperreq,
                "watcher.proc.jiffyreq" : info.status.jiffyperreq});
        }
        if (this.healthChangeCallback && info.status.health_status_timestamp &&
            changeInHealth && info.status.health_is_down !== this.overall_health_is_down) {
            //Change in health of this pid(worker) and the worker health is different from overall health
            if (info.status.health_is_down) {
                //this worker is down and overall health is up, so change it to down
                this.overall_health_is_down =  info.status.health_is_down;
                this.healthChangeCallback(this);
            } else {
                /*worker health changes from down to up, check if any other worker is down
                  if not change the overall health to up else do nothing*/
                if (!this.isAnyWorkerDown()) {
                    this.overall_health_is_down =  info.status.health_is_down;
                    this.healthChangeCallback(this);
                }
            }
        }
        for (i in statuses) {
            if (statuses[i].oreqs) {
                totalOpenRequests += statuses[i].oreqs;
            }
        }
        wmetric.set({ "watcher.proc.openreqs" : totalOpenRequests }, 0);
        if (this.maxOpenRequests < totalOpenRequests) {
            wmetric.set({ "watcher.proc.maxopenreqs" : totalOpenRequests }, 0);
            this.maxOpenRequests = totalOpenRequests;
        }
    },
    checkStatus : function (wmetric) {
        var i,
            self = this,
            maxTimeout;
        for (i in statuses) {

            maxTimeout = statuses[i].listen ? self.maxTimeout : self.maxStartTimeout;
            /*
             *  This condition descrbes the potential endless loop or extremely
             *  slow event processing in Javascript, where the time elapsed between the artificialy
             *  fed in event and its execution exceeds N seconds and there are not
             *  many events (<2) have been processed in one second.
             *
             *  This can however be due to a total overload of the system, where the process itself
             *  is not getting scheduled for a long time.
             */
            if (!statuses[i].debug && statuses[i].curr.elapsed >= maxTimeout &&
                    statuses[i].curr.events <= 2.0) { //&& statuses[i].last.events <= 1.0
                if (statuses[i].kill) {

                    console.log('Sending SIGKILL due endless loop suspect ' + i);
                    try {
                        process.kill(i, 'SIGKILL');
                        wmetric.increment("watcher.proc.killed");
                    } catch (e) {
                    }

                    delete statuses[i];
                    this.postDelete(i);
                } else {

                    console.log('Sending SIGHUP to ' + i);
                    try {
                        process.kill(i, 'SIGHUP');
                        wmetric.increment("watcher.proc.graceful");
                    } catch (ex) {
                    }

                    statuses[i].kill = true;
                }
            } else {
                statuses[i].kill = false;
            }
        }
    },
    /*
     * Verify if process has died, report the metric and
     * Remove it from the table.
     **/
    removeIfNotRunning : function (pid, wmetric) {
        try {
            fs.statSync('/proc/' + pid + '/stat');
        } catch (e) {
            wmetric.increment("watcher.proc.died");
            delete statuses[pid];
            console.log("REMOVED FROM table " + pid);
            this.postDelete(pid);
        }
    },
    checkInactivity : function (wmetric) {
        var i, now, timeout, self = this;
        for (i in statuses) {
            this.removeIfNotRunning(i, wmetric);
        }

        // check those, from which we didn't really get a signal
        now = (new Date()).getTime() / 1000;
        for (i in statuses) {

            timeout = (statuses[i].listen ? self.maxTimeout : self.maxStartTimeout) + 30000;
            if (now - statuses[i].curr.wts >= timeout) {
                console.log('Sending SIGKILL due to ' + timeout + ' sec inactivity to ' + i);
                try {
                    process.kill(i, 'SIGKILL');
                } catch (e) {
                }
                wmetric.increment("watcher.proc.killed");
                delete statuses[i];
                this.postDelete(i);
            }
        }
    },
    postDelete : function (pid) {
        //if health is up already, nothing to do
        if (this.healthChangeCallback && this.overall_health_is_down && !this.isAnyWorkerDown()) {
            //health is down, but none of the workers are down
            this.overall_health_is_down = false;
            this.healthChangeCallback(this);
        }
    },
    isAnyWorkerDown : function () {
        var i;
        for (i in statuses) {
            if (statuses[i].curr.health_status_timestamp && statuses[i].curr.health_is_down) {
                return true;
            }
        }
        return false;
    }

};

if (!module.parent) {
    watcher = new Watcher({});
} else {
    module.exports.Watcher = Watcher;
    module.exports.statuses = statuses;
}
