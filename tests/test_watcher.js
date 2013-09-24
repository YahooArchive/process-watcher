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

function getMessage(cpu, ts, elapsed, proc) {
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
                title: '/branches/v0.4/build/default/node' 
            } 
        }
    );
};

var lastKill = '', lastKillPID = 0;

process.kill = function(pid, sig) {
    lastKill = sig;
    lastKillPID = pid;
    console.log("KILL called " + sig);
};

fs.unlink(dgpath);     
fs.unlink(statusPath);
   
var testee = new watcher.Watcher({ max_inactive : 0.001, monitor : 0.001,
    monPath: dgpath, statusPath: statusPath });
           
suite.add(new YUITest.TestCase({
    name : "Watcher Test",
    
    'Test Timer' : function() {
       this.wait(function() {
           clearInterval(testee._inactivityInt);
           clearInterval(testee._monitorInt);
           Assert.isTrue(true);
       }, 100);
    },
    
    'Verify status OK is returned' : function() {
        var message = new Buffer(getMessage(0, Date.now(), 0)),
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
				
			// do subsequent message, which will update statistics
			message = new Buffer(getMessage(50, Date.now(), 0));
			client.send(message, 0, message.length, dgpath, function (err, bytes) {
			    Assert.isTrue(!err); 
			    self.wait(function() { 
				Assert.areEqual(watcher.statuses[pid].last.cpu, 25);
				Assert.areEqual(watcher.statuses[pid].curr.cpu, 50);
				testee._monitorSocket.close();
				client.close();
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
        watcher.statuses['aaa'] = {
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
        watcher.statuses['xyz'] = {}; 
        testee.checkInactivity(testee._metric); 
        Assert.areEqual(watcher.statuses['xyz'], undefined);

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
    },
	
    'Clean up - should run as the last' : function() {
	var ex = null;
	try {
            testee.closeStatusService();
	} catch (e) {
	    ex = e;
	}
	Assert.areEqual(ex, null);
	process.emit('exit');
    }
}));
