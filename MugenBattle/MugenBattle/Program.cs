using System.Diagnostics;

namespace MugenBattle
{
    class Program
    {
        static void Main(string[] args)
        {
            // Start the child process.
            Process p = new Process();
            // Redirect the output stream of the child process.
            p.StartInfo.UseShellExecute = false;
            p.StartInfo.RedirectStandardOutput = true;
            p.StartInfo.FileName = "runMugenTourney.bat";
            p.StartInfo.Arguments = "kmf kmf cats_on_the_roof";
            p.Start();
            // Do not wait for the child process to exit before
            // reading to the end of its redirected stream.
            // p.WaitForExit();
            // Read the output stream first and then wait.
            string output = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
        }
    }
}