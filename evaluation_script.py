import argparse
import json
import shutil
import subprocess
import time
from datetime import datetime
import re
import sys
import os
import time

def read_settings(file_path):
    """Read and parse the settings.js file to get agent profiles."""
    with open(file_path, 'r', encoding='utf-8') as file:
        content = file.read()

    # Remove `export default` and trailing commas
    content = re.sub(r'export\s+default', '', content)
    content = re.sub(r',\s*(?=[}\]])', '', content)

    # Remove JavaScript comments
    content = re.sub(r'//.*', '', content)

    # Remove trailing commas (e.g., before } or ])
    content = re.sub(r',\s*(?=[}\]])', '', content)

    # Strip leading and trailing whitespace
    content = content.strip()

    json_data = json.loads(content)

    profiles = json_data['profiles']

    ## profiles is a list of strings like "./andy.json" and "./bob.json"

    agent_names = [profile.split('/')[-1].split('.')[0] for profile in profiles]
    return agent_names

def edit_settings(file_path, dict_to_change):
    """Edit the settings.js file to include the specified agent profiles."""
    with open(file_path, 'r', encoding='utf-8') as file:
        content = file.read()
    
    # Remove `export default` and trailing commas
    content = re.sub(r'export\s+default', '', content)
    content = re.sub(r',\s*(?=[}\]])', '', content)

    # Remove JavaScript comments
    content = re.sub(r'//.*', '', content)

    # Remove trailing commas (e.g., before } or ])
    content = re.sub(r',\s*(?=[}\]])', '', content)

    # Strip leading and trailing whitespace
    content = content.strip()

    json_data = json.loads(content)

    for key, value in dict_to_change.items():
        json_data[key] = value

    # Write the updated content back to the file
    with open(file_path, 'w', encoding='utf-8') as file:
        file.write(f"export default\n{json.dumps(json_data, indent=2)}") 

def check_task_completion(agents):
    """Check memory.json files of all agents to determine task success/failure."""
    for agent in agents:
        memory_path = f"bots/{agent}/memory.json"
        try:
            with open(memory_path, 'r') as f:
                memory = json.load(f)
                
            # Check the last system message in turns
            for turn in reversed(memory['turns']):
                if turn['role'] == 'system' and 'code' in turn['content']:
                    # Extract completion code
                    if 'code : 2' in turn['content']:
                        return True  # Task successful
                    elif 'code : 4' in turn['content']:
                        return False  # Task failed
            
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"Error reading memory for agent {agent}: {e}")
            continue
            
    return False  # Default to failure if no conclusive result found

def update_results_file(task_id, success_count, total_count, time_taken, experiment_results):
    """Update the results file with current success ratio and time taken."""
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    filename = f"results_{task_id}_{timestamp}.txt"
    
    success_ratio = success_count / total_count
    
    with open(filename, 'w') as f:
        f.write(f"Task ID: {task_id}\n")
        f.write(f"Experiments completed: {total_count}\n")
        f.write(f"Successful experiments: {success_count}\n")
        f.write(f"Success ratio: {success_ratio:.2f}\n")
        f.write(f"Time taken for last experiment: {time_taken:.2f} seconds\n")
        
        # Write individual experiment results
        for i, result in enumerate(experiment_results, 1):
            f.write(f"Experiment {i}: {'Success' if result['success'] else 'Failure'}, Time taken: {result['time_taken']:.2f} seconds\n")
        
        # Write aggregated metrics
        total_time = sum(result['time_taken'] for result in experiment_results)
        f.write(f"\nAggregated metrics:\n")
        f.write(f"Total experiments: {total_count}\n")
        f.write(f"Total successful experiments: {success_count}\n")
        f.write(f"Overall success ratio: {success_ratio:.2f}\n")
        f.write(f"Total time taken: {total_time:.2f} seconds\n")
        f.write(f"Average time per experiment: {total_time / total_count:.2f} seconds\n")
        f.write(f"Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")

def launch_server_experiment(task_path, task_id, num_exp, server, num_agents=2, model="gpt-4o"):
    server_path, server_port = server
    edit_server_properties_file(server_path, server_port)
    
    # rename the agents for logging purposes
    # TODO: fix the file naming procedure
    
    
    session_name = str(server_port - 55916)
    if num_agents == 2:
        agent_names = [f"andy_{session_name}", f"jill_{session_name}"]
        models = [model] * 2
    else:
        agent_names = [f"andy_{session_name}", f"jill_{session_name}", f"bob_{session_name}"]
        models = [model] * 3
    make_profiles(agent_names, models)

    edit_settings("settings.js", {"port": server_port, 
                                  "profiles": [f"./{agent}.json" for agent in agent_names]})
    launch_world(server_path, session_name="server_" + session_name, agent_names=agent_names)

    subprocess.run(['tmux', 'new-session', '-d', '-s', session_name], check=True) 
    
    cmd = f"node main.js --task_path {task_path} --task_id {task_id}"
    for _ in range(num_exp):
              # Send the command and a newline (C-m) to execute it
        subprocess.run(["tmux", "send-keys", "-t", session_name, cmd, "C-m"])
        # Add a small delay between commands (optional)
        subprocess.run(["tmux", "send-keys", "-t", session_name, "sleep 1", "C-m"])

    subprocess.run(["tmux", "send-keys", "-t", session_name, f"/op {agent_names[0]}", "C-m"])

def make_profiles(agent_names, models):
    assert len(agent_names) == len(models)
    for index in range(len(agent_names)):
        content = {"name": agent_names[index], "model": models[index], "modes": {"hunting": False}}
        with open(f"{agent_names[index]}.json", 'w') as f:
            json.dump(content, f)

def create_server_files(source_path, num_copies):
    """Create multiple copies of server files for parallel experiments."""
    servers = []
    for i in range(num_copies):
        dest_path = f"../server_data_{i}/"
        copy_server_files(source_path, dest_path)
        edit_server_properties_file(dest_path, 55916 + i)
        servers.append((dest_path, 55916 + i))
    return servers
    
def edit_server_properties_file(dest_path, new_port):
    """Edit the server properties file to change the port."""
    properties_file = os.path.join(dest_path, "server.properties")
    try:
        with open(properties_file, 'r') as f:
            lines = f.readlines()
        with open(properties_file, 'w') as f:
            for line in lines:
                if line.startswith("server-port="):
                    f.write(f"server-port={new_port}\n")
                else:
                    f.write(line)
        print(f"Server properties file updated with new port: {new_port}")  
    except Exception as e:
        print(f"Error editing server properties file: {e}")

def clean_up_server_files(num_copies):
    """Delete server files from multiple locations."""
    for i in range(num_copies):
        dest_path = f"../server_data_{i}/"
        delete_server_files(dest_path)

def copy_server_files(source_path, dest_path):
    """Copy server files to the specified location."""
    try:
        shutil.copytree(source_path, dest_path)
        print(f"Server files copied to {dest_path}")
    except Exception as e:
        print(f"Error copying server files: {e}")

def delete_server_files(dest_path):
    """Delete server files from the specified location."""
    try:
        shutil.rmtree(dest_path)
        print(f"Server files deleted from {dest_path}")
    except Exception as e:
        print(f"Error deleting server files: {e}")

def launch_world(server_path="../server_data/", agent_names=["andy", "jill"], session_name="server"):
    """Launch the Minecraft world."""
    print(server_path)
    cmd = f"cd {server_path} && java -jar server.jar"
    subprocess.run(['tmux', 'new-session', '-d', '-s', session_name], check=True)
    subprocess.run(["tmux", "send-keys", "-t", session_name, cmd, "C-m"])
    for agent in agent_names:
        subprocess.run(["tmux", "send-keys", "-t", session_name, f"/op {agent}", "C-m"]) 
    time.sleep(5)

def detach_process(command):
    """
    Launches a subprocess and detaches from it, allowing it to run independently.

    Args:
        command: A list of strings representing the command to execute, e.g., ['python', 'my_script.py'].
    """

    try:
        # Create a new process group so the child doesn't get signals intended for the parent.
        #  This is crucial for proper detachment.
        kwargs = {}
        if sys.platform == 'win32':
            kwargs.update(creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)  # Windows specific

        process = subprocess.Popen(command, 
                                   stdin=subprocess.PIPE, # Prevent stdin blocking
                                   stdout=subprocess.PIPE, # Redirect stdout
                                   stderr=subprocess.PIPE, # Redirect stderr
                                   close_fds=True,  # Close open file descriptors
                                   **kwargs)

        print(f"Process launched with PID: {process.pid}")
        return process.pid  # Return the PID of the detached process

    except FileNotFoundError:
        print(f"Error: Command not found: {command}")
        return None
    except Exception as e:
        print(f"An error occurred: {e}")
        return None


def run_experiment(task_path, task_id, num_exp):
    """Run the specified number of experiments and track results."""
    # Read agent profiles from settings.js
    agents = read_settings(file_path="settings.js")
    print(f"Detected agents: {agents}")
    
    success_count = 0
    experiment_results = []
    
    for exp_num in range(num_exp):
        print(f"\nRunning experiment {exp_num + 1}/{num_exp}")
        
        start_time = time.time()
        
        # Run the node command
        cmd = f"node main.js --task_path {task_path} --task_id {task_id}"
        try:
            subprocess.run(cmd, shell=True, check=True)
        except subprocess.CalledProcessError as e:
            print(f"Error running experiment: {e}")
            continue
            
        # Check if task was successful
        success = check_task_completion(agents)
        if success:
            success_count += 1
            print(f"Experiment {exp_num + 1} successful")
        else:
            print(f"Experiment {exp_num + 1} failed")
        
        end_time = time.time() 
        time_taken = end_time - start_time
        
        # Store individual experiment result
        experiment_results.append({
            'success': success,
            'time_taken': time_taken
        })
        
        # Update results file after each experiment
        update_results_file(task_id, success_count, exp_num + 1, time_taken, experiment_results)
        
        # Small delay between experiments
        time.sleep(1)
    
    final_ratio = success_count / num_exp
    print(f"\nExperiments completed. Final success ratio: {final_ratio:.2f}")
    return experiment_results

def main():
    # edit_settings("settings.js", {"profiles": ["./andy.json", "./jill.json"], "port": 55917})
    # edit_server_properties_file("../server_data/", 55917)

    parser = argparse.ArgumentParser(description='Run Minecraft AI agent experiments')
    parser.add_argument('--task_path', default="example_tasks.json", help='Path to the task file')
    parser.add_argument('--task_id', default="multiagent_techtree_1_stone_pickaxe", help='ID of the task to run')
    parser.add_argument('--num_exp', default=5, type=int, help='Number of experiments to run')
    parser.add_argument('--num_parallel', default=0, type=int, help='Number of parallel servers to run')

    args = parser.parse_args()

    # kill all tmux session before starting
    try: 
        subprocess.run(['tmux', 'kill-server'], check=True)
    except: 
        print("No tmux session to kill")
    if args.num_parallel == 0:
        launch_world()
        run_experiment(args.task_path, args.task_id, args.num_exp)
    else: 
        servers = create_server_files("../server_data/", args.num_parallel)
        for server in servers:
            launch_server_experiment(args.task_path, args.task_id, args.num_exp, server)
            time.sleep(5)
    
    # run_experiment(args.task_path, args.task_id, args.num_exp)

if __name__ == "__main__":
    main()