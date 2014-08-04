var YUITest = require('yuitest').YUITest,
    Assert = YUITest.Assert,
    suite = new YUITest.TestSuite("Unit"),
    fs = require('fs'),
    watcher = require(".."),
    dgram = require('unix-dgram'),
    dgpath = '/tmp/watcher_test_dgram',
    pid = process.pid,
    statusPath = '/tmp/watcher_status_path_test';

YUITest.TestRunner.add(suite);

function getMessage(cpu, ts, elapsed, oreqs, proc) {    
    proc = proc || pid;
    return JSON.stringify({
        status:
            {
		user_cpu: 0,
                pid: pid,
                mem: 0.66,
                cpu: cpu,
                elapsed: elapsed,
                events: 0,
                cluster: 32768,
                cpuperreq: 0.23,
                sys_cpu: 0,
                ts: ts,
                oreqs: oreqs || 0,
                title: '/branches/v0.4/build/default/node' 
            } 
        }
    );
}

function getMessageWithHealth(custom_pid, cpu, ts, elapsed, proc, hts, isDown) {
    proc = proc || pid;
    return JSON.stringify({
        status:
        {
            user_cpu: 0,
            pid: custom_pid,
            mem: 0.66,
            cpu: cpu,
            elapsed: elapsed,
            events: 0,
            cluster: 32768,
            cpuperreq: 0.23,
            sys_cpu: 0,
            ts: ts,
            title: '/branches/v0.4/build/default/node',
            health_status_timestamp : hts,
            health_is_down : isDown
        } 
    });
}

var healthChangeCounter = 0;
function healthChange(obj) {
    Assert.isTrue(obj instanceof watcher.Watcher);
    ++healthChangeCounter;
}
var healthChangeCalled = 0;

var lastKill = '', lastKillPID = 0;

process.kill = function(pid, sig) {
    lastKill = sig;
    lastKillPID = pid;
    console.log("KILL called " + sig);
};

fs.unlink(dgpath);     
fs.unlink(statusPath);
   
var testee;
           
suite.add(new YUITest.TestCase({
    name : "Watcher Test",
    'Test Watcher with no health change callback' : function() {
        var test_watcher = new watcher.Watcher({ config : { max_inactive : 0.001, monitor : 0.001,
            monPath: dgpath, statusPath: statusPath }});
        Assert.isNotNull(test_watcher);
        Assert.areEqual(healthChangeCalled, healthChangeCounter); //0
    },
    'Test Watcher with health change callback' : function() {
        testee = new watcher.Watcher({ max_inactive : 0.001, monitor : 0.001,
            monPath: dgpath, statusPath: statusPath }, healthChange);
        Assert.isNotNull(testee);
        Assert.areEqual(++healthChangeCalled, healthChangeCounter); //0
    },    
    'Test Timer' : function() {
       this.wait(function() {
           clearInterval(testee._inactivityInt);
           clearInterval(testee._monitorInt);
           Assert.isTrue(true);
       }, 100);
    },
    
    'Verify status OK is returned' : function() {
        var message = new Buffer(getMessage(0, Date.now(), 0, 10)),
        self = this;
        
        self.wait(function() {
            var client = dgram.createSocket("unix_dgram");
            client.send(message, 0, message.length, dgpath, function (err, bytes) {
                if (err) {
                    console.log("Message Error " + (err.stack || err.toString()));
                    Assert.isTrue(false);
                } else {
                    self.wait(function(){
			console.log(require('util').inspect(watcher.statuses, true, 10));
			Assert.areEqual(watcher.statuses[pid].curr.cpu, 0);
			Assert.areEqual(watcher.statuses[pid].last.cpu, 0);
			Assert.areEqual(watcher.statuses[pid].oreqs, 10);
				
			// do subsequent message, which will update statistics
			message = new Buffer(getMessage(50, Date.now(), 0, 20));
			client.send(message, 0, message.length, dgpath, function (err, bytes) {
				Assert.isTrue(!err); 
				self.wait(function() { 
				Assert.areEqual(watcher.statuses[pid].last.cpu, 25);
				Assert.areEqual(watcher.statuses[pid].curr.cpu, 50);
				Assert.areEqual(watcher.statuses[pid].oreqs, 20);
				//testee._monitorSocket.close();
				client.close();
				}, 100);
			});
                    }, 500);              
                    console.log("Wrote " + bytes + " bytes to socket.");
                }
		});
        }, 300);       
    },
    'Verify health callback is called' : function() {
	var ts = Date.now(),
		message,
		self = this,
		other_pid = 12345;
	Assert.areEqual(false, testee.overall_health_is_down, 'initially down should be false');
	message = new Buffer(getMessageWithHealth(pid, 0, Date.now(), 0, null, ts, true)),
        self.wait(function() {
            var client = dgram.createSocket("unix_dgram");
            client.send(message, 0, message.length, dgpath, function (err, bytes) {
		if (err) {
			console.log("Message Error " + (err.stack || err.toString()));
			Assert.isTrue(false);
		} else {
			self.wait(function(){
			Assert.areEqual(true, testee.overall_health_is_down, 'health should be down now');
			Assert.areEqual(++healthChangeCalled, healthChangeCounter, 'should be 2 now');						
			// other worker sends down                           
			message = new Buffer(getMessageWithHealth(other_pid, 50, Date.now(), 0, other_pid, ts + 1000, true));
			client.send(message, 0, message.length, dgpath, function (err, bytes) {
				Assert.isTrue(!err);
				self.wait(function() { 
				Assert.areEqual(true, testee.overall_health_is_down, 'health should still be down');
				Assert.areEqual(healthChangeCalled, healthChangeCounter, 'counter should be still 2');
				
				//do subsequent message other pid with up
				message = new Buffer(getMessageWithHealth(other_pid, 50, Date.now(), 0, null, ts + 2000, false));
				client.send(message, 0, message.length, dgpath, function (err, bytes) {
					Assert.isTrue(!err); 
					self.wait(function() { 
					Assert.areEqual(true, testee.overall_health_is_down, 'health should still be down as one worker is down');
					Assert.areEqual(healthChangeCalled, healthChangeCounter, 'no change in health');
					message = new Buffer(getMessageWithHealth(pid, 50, Date.now(), 0, other_pid, ts + 1200, false));
					client.send(message, 0, message.length, dgpath, function (err, bytes) {
						Assert.isTrue(!err); 
						self.wait(function() { 
						Assert.areEqual(false, testee.overall_health_is_down, 'both worker is up');
						Assert.areEqual(++healthChangeCalled, healthChangeCounter, 'should be 3 now'); //health change counter shud remain the same						
						delete watcher.statuses[other_pid]; //remove the entry for other_pid
						testee._monitorSocket.close();
						client.close();						
						}, 100);
					});    
					}, 100);
				});
				}, 100);
			});
			}, 500);                    
			console.log("Wrote " + bytes + " bytes to socket.");
		}
	});
        }, 300);       
    },	
    'Test checkStatus' :function() {
        var sb = {
            increment : function(x) {
                this[x] = true;
            }
        };
       
        // This should trigger the SIGHUB
        watcher.statuses.aaa = {
		curr : {
		elapsed : 70000,
		events: 1
		}
	};
       
	testee.checkStatus(sb);
        Assert.isTrue(sb["watcher.proc.graceful"]);

        testee.checkStatus(sb);
        Assert.isTrue(sb["watcher.proc.killed"]);
    },
    
    'Test inactivity' :function(f) {
        watcher.statuses.xyz = {}; 
        testee.checkInactivity(testee._metric); 
        Assert.areEqual(watcher.statuses.xyz, undefined);
        var temp = watcher.statuses[pid];
       
        watcher.statuses[pid] = {
            curr : {
               wts : 1000
            }
        };
       
        lastKill = '';
        lastKillPID = 0;
        testee.checkInactivity(testee._metric);

        // Verify proc is killed
        Assert.areEqual(lastKill, 'SIGKILL');
        Assert.areEqual(lastKillPID, pid);
	watcher.statuses[pid] = temp; //restore pid status
    },
    'Test inactivity and health check reset' :function(f) {
	var ts = Date.now();
	watcher.statuses['12345'] = {};
	testee.overall_health_is_down = true;
	watcher.statuses[pid].curr.health_is_down = true;
	
	testee.checkInactivity(testee._metric); 
	Assert.areEqual(watcher.statuses['12345'], undefined);
	Assert.areEqual(true, testee.overall_health_is_down);
	

	watcher.statuses[pid] = {
            curr : {
                wts : 1000
            }
        };
	
	lastKill = '';
	lastKillPID = 0;
	testee.checkInactivity(testee._metric);

	// Verify proc is killed      
	Assert.areEqual(lastKill, 'SIGKILL');
	Assert.areEqual(lastKillPID, pid);	
	Assert.areEqual(false, testee.overall_health_is_down);
    },
	
    'Clean up - should run as the last' : function() {
        var ex = null;
        try {
                testee.closeStatusService();
        } catch (e) {
            ex = e;
        }
        Assert.areEqual(ex, null);
    }
}));
