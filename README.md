process-watcher
=======
It is responsible for:

* Listen to all the nodejs processes.
* Send SIGHUP to the process, which didn't have any throughput of events within 30 seconds.
* Send SIGKILL to the process, which didn't die after getting SIGHUP withing 30 seconds.
* Send SIGKILL to the process, which stopped sending status updates for 60 seconds.

* Write following  metrics for respective events described above.
    * watcher.proc.died: Incremented when process has died for any reason, potentially caused by SIGKILL or other means.
    * watcher.proc.graceful: Incremented if SIGHUP was sent to process.
    * watcher.proc.killed: Incremented when watcher sends the SIGKILL to the process.
    * watcher.reqcpu: Metric demonstrating an average of how many CPU jiffies per request process consumes.

install
-------
With npm do:

`npm install process-watcher`

usage
-----

```javascript
var watcher = require('process-watcher');
var watcher_instance = new watcher.Watcher({ metric : watcher_metric, config : watcher_config });
```

example
-------

```javascript
var watcher = require('process-watcher');

/*
 * Dummy metric monitoring object.
 */
var watcher_metric = {
    /**
     * Increments metric
     */
    increment : function (name, v) {
        // Add implementation as necessary
    },
    /**
     * Set the metric or multiple metrics at the same time.
     * */
    set : function (names, v) {
        // Add implementation as necessary
    }
};

var dgpath = '/tmp/watcher_test_dgram',
    statusPath = '/tmp/watcher_status_path_test',
    watcher_config = { max_inactive : 0.001, monitor : 0.001,  monPath: dgpath,
        timeout : 30, timeout_start : 60 };

//Instantiate watcher
var watcher_instance = new watcher.Watcher({ metric : watcher_metric, config : watcher_config });
```
