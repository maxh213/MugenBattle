//TODO: Refactor so this stuff isn't all global
var pg = require('pg');
var childProcess = require('child_process');
var query = require('pg-query');
var mugenBatLocation = 'mugen/runMugenTourney.bat';
var fighter1 = "";
var fighter2 = "";
var stage = "";
var cmdInput = '"mugen/runMugen.bat" android18 buu bamboo';
var characters = [];
var stages = [];

//Main code
query.connectionParameters = conString;
loadFightersAndStage();

function everythingLoaded() {
	console.log("Loading " + fighter1 + " VS " + fighter2 + "!");
	var mugen = childProcess.exec(cmdInput, function (error, stdout, stderr) {
		if (error) {
			console.log("Error occured while loading, retrying with the same fighters...");
			//console.log(error.stack);  
			//console.log(stdout);
			everythingLoaded();
		} else {
			recordWinner(stdout, fighter1, fighter2);
		}
	});

    mugen.on('exit', function (code) {
		//console.log("Match Over!");
		//console.log('Child process exited with exit code '+code);
		//everythingLoaded();
	});
}

function generateNextFightDetails() {
	var randomCharacterIndex = Math.floor(Math.random()*characters.length);
	fighter1 = characters[randomCharacterIndex].file_name;
	randomCharacterIndex = Math.floor(Math.random()*characters.length);
	fighter2 = characters[randomCharacterIndex].file_name;
    
	var randomStageIndex = Math.floor(Math.random()*stages.length);
	stage = stages[randomStageIndex].file_name;
	
	//need quotes around each input otherwise the bat file will get confused by spaces
	cmdInput = '"' + mugenBatLocation + '"  "' + fighter1 + '"  "' + fighter2 + '" "' + stage + '"';
	everythingLoaded();
}

function loadFightersAndStage() {
    var promise = query("select * from fighter where active = '1'");
    promise.spread(onFighterLoadSuccess, onError);
}

function onFighterLoadSuccess(rows, result) {
    characters = result.rows;
    var promise = query("select * from stage where active = '1'");
    promise.spread(onStageLoadSuccess, onError);
}

function onStageLoadSuccess(rows, result) {
    stages = result.rows;
    generateNextFightDetails();
}

function onError(error) {
    console.log(error);
}

function recordWinner(stdout) {
    //stdout example for 2 rounds: 
    // winningteam = 1
    // winningteam = 2
    // winningteam = 1
    //match how many 1s or 2s (for fighter 1 & 2) in the stdout result
	
	//DOUBLE CHECK IF THE BELOW IS EFFECTED BY IF THEY HAVE NUMBERS IN THEIR NAME.
    var fighter1Wins = stdout.replace(/[^1]/g, "").length;
    var fighter2Wins = stdout.replace(/[^2]/g, "").length;
    var winner = "";
    var WINNER_UPDATE_SCRIPT = 'update fighter set matches_won = matches_won + 1 where file_name = $1';
    var LOSER_UPDATE_SCRIPT = 'update fighter set matches_lost = matches_lost + 1 where file_name = $1';
    var DRAW_UPDATE_SCRIPT = 'update fighter set matches_drawn = matches_drawn + 1 where file_name = $1';
	var FIGHT_HISTORY_UPDATE_SCRIPT = 'insert into fight_history (fighter_one_id, fighter_two_id, stage_id, victor) '
		+ 'values ((select id from fighter where file_name = $1), '
		+'(select id from fighter where file_name = $2), '
		+'(select id from stage where file_name = $3), '
		+'(select id from fighter where file_name = $4))';
	var STAGE_UPDATE_SCRIPT = 'update stage set times_used = times_used + 1 where file_name = $1'
    if (fighter1Wins > fighter2Wins) {
        winner = fighter1;
        query(WINNER_UPDATE_SCRIPT, [fighter1]);
        query(LOSER_UPDATE_SCRIPT, [fighter2]);
		query(FIGHT_HISTORY_UPDATE_SCRIPT, [fighter1, fighter2, stage, fighter1]);
    } else if (fighter1Wins < fighter2Wins) {
        winner = fighter2;
        query(WINNER_UPDATE_SCRIPT, [fighter2]);
        query(LOSER_UPDATE_SCRIPT, [fighter1]);
		query(FIGHT_HISTORY_UPDATE_SCRIPT, [fighter1, fighter2, stage, fighter2]);
    } else {
        winner = "None! Match was a draw!";
        query(DRAW_UPDATE_SCRIPT, [fighter1]);
        query(DRAW_UPDATE_SCRIPT, [fighter2]);
		query(FIGHT_HISTORY_UPDATE_SCRIPT, [fighter1, fighter2, stage, null]);
    }
	query(STAGE_UPDATE_SCRIPT, [stage]);
    console.log("Winner: " + winner + "!");
    generateNextFightDetails();
}
