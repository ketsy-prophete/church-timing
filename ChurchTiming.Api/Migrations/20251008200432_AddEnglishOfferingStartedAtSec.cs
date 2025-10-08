using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace ChurchTiming.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddEnglishOfferingStartedAtSec : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "EnglishOfferingStartedAtSec",
                table: "Runs",
                type: "INTEGER",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "EnglishOfferingStartedAtSec",
                table: "Runs");
        }
    }
}
